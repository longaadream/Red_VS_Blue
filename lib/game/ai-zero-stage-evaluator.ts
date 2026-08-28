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
const pointDistance = (left: { x: number; y: number }, right: { x: number; y: number }) => (
  Math.abs(left.x - right.x) + Math.abs(left.y - right.y)
)
const distance = (left: AIObservedPiece, right: AIObservedPiece) => {
  const a = position(left)
  const b = position(right)
  return a && b ? pointDistance(a, b) : Number.POSITIVE_INFINITY
}

function engagement(source: AIObservedPiece, target: AIObservedPiece) {
  return distance(source, target) <= Math.max(1, source.moveRange + 1)
}

function lethalOpportunities(sources: AIObservedPiece[], targets: AIObservedPiece[]) {
  return sources.reduce((total, source) => total + targets.reduce((subtotal, target) => {
    if (!engagement(source, target)) return subtotal
    if (Math.max(1, source.attack - target.defense) < target.currentHp) return subtotal
    return subtotal + (target.isCore ? 2 : 1)
  }, 0), 0)
}

function attackPressure(sources: AIObservedPiece[], targets: AIObservedPiece[]) {
  return sources.reduce((total, source) => total + targets.reduce((subtotal, target) => {
    if (!engagement(source, target)) return subtotal
    const damage = Math.max(1, source.attack - target.defense) / Math.max(1, target.maxHp)
    const finishPriority = 1 + (1 - ratio(target.currentHp, target.maxHp))
    const targetPriority = target.isCore ? 1.5 : 1
    return subtotal + damage * finishPriority * targetPriority
  }, 0), 0)
}

function dangerExposure(targets: AIObservedPiece[], sources: AIObservedPiece[]) {
  return targets.reduce((total, target) => total + sources.reduce((subtotal, source) => {
    if (!engagement(source, target)) return subtotal
    const damage = Math.max(1, source.attack - target.defense) / Math.max(1, target.maxHp)
    const vulnerability = 1 + (1 - ratio(target.currentHp, target.maxHp))
    const reach = Math.max(1, source.moveRange + 1)
    const proximity = 1 + Math.max(0, reach - distance(source, target)) / reach
    return subtotal + damage * vulnerability * proximity
  }, 0), 0)
}

function strategicPosition(
  pieces: AIObservedPiece[],
  hostile: AIObservedPiece[],
  observation: AIObservation,
) {
  const center = {
    x: (observation.map.width - 1) / 2,
    y: (observation.map.height - 1) / 2,
  }
  const centerRadius = Math.max(1, center.x + center.y)
  const mapDiameter = Math.max(1, observation.map.width - 1 + observation.map.height - 1)
  const hostileObjectives = hostile.filter(piece => piece.isCore)
  const targets = hostileObjectives.length > 0 ? hostileObjectives : hostile

  return pieces.reduce((total, piece) => {
    const point = position(piece)
    if (!point) return total
    const centerControl = 1 - Math.min(1, pointDistance(point, center) / centerRadius)
    const targetDistance = targets.length > 0
      ? Math.min(...targets.map(target => {
        const targetPoint = position(target)
        return targetPoint ? pointDistance(point, targetPoint) : mapDiameter
      }))
      : mapDiameter
    const objectivePressure = 1 - Math.min(1, targetDistance / mapDiameter)
    return total + centerControl * 0.75 + objectivePressure * 1.25
  }, 0)
}

function futureAttackPotential(sources: AIObservedPiece[], targets: AIObservedPiece[]) {
  return sources.reduce((total, source) => total + targets.reduce((subtotal, target) => {
    const steps = distance(source, target)
    if (!Number.isFinite(steps)) return subtotal
    const projectedRange = Math.max(1, source.moveRange + 1)
    const proximity = projectedRange / Math.max(projectedRange, steps)
    const damage = Math.max(1, source.attack - target.defense) / Math.max(1, target.maxHp)
    const immediateCoverage = steps <= 1 ? 1 : 0
    const finishPriority = 1 + (1 - ratio(target.currentHp, target.maxHp)) * 0.5
    const targetPriority = target.isCore ? 1.5 : 1
    return subtotal + targetPriority * finishPriority * (
      proximity * (0.5 + damage)
      + immediateCoverage * (1 + damage)
    )
  }, 0), 0)
}

function supportPotential(pieces: AIObservedPiece[]) {
  let total = 0
  for (let left = 0; left < pieces.length; left += 1) {
    for (let right = left + 1; right < pieces.length; right += 1) {
      const steps = distance(pieces[left], pieces[right])
      if (!Number.isFinite(steps)) continue
      const convergence = Math.max(1, pieces[left].moveRange + pieces[right].moveRange)
      const proximity = 1 / (1 + steps / convergence)
      const need = 1 + (
        2 - ratio(pieces[left].currentHp, pieces[left].maxHp)
          - ratio(pieces[right].currentHp, pieces[right].maxHp)
      ) / 2
      total += proximity * need
    }
  }
  return total
}

const cellKey = (x: number, y: number) => `${x},${y}`

function mobilityPotential(pieces: AIObservedPiece[], observation: AIObservation) {
  const walkable = new Set(observation.map.tiles
    .filter(tile => tile.props.walkable)
    .map(tile => cellKey(tile.x, tile.y)))
  const occupied = new Set(observation.pieces.filter(alive).flatMap(piece => {
    const point = position(piece)
    return point ? [cellKey(point.x, point.y)] : []
  }))
  return pieces.reduce((total, piece) => {
    const start = position(piece)
    if (!start || piece.moveRange <= 0) return total
    const startKey = cellKey(start.x, start.y)
    const visited = new Set([startKey])
    const queue = [{ ...start, steps: 0 }]
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]
      if (current.steps >= piece.moveRange) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = current.x + dx
        const y = current.y + dy
        const key = cellKey(x, y)
        if (visited.has(key) || !walkable.has(key) || (key !== startKey && occupied.has(key))) continue
        visited.add(key)
        queue.push({ x, y, steps: current.steps + 1 })
      }
    }
    const theoretical = Math.max(1, 2 * piece.moveRange * (piece.moveRange + 1))
    return total + Math.min(1, (visited.size - 1) / theoretical)
  }, 0)
}

function terrainValue(pieces: AIObservedPiece[], observation: AIObservation) {
  const tiles = new Map(observation.map.tiles.map(tile => [cellKey(tile.x, tile.y), tile]))
  return pieces.reduce((total, piece) => {
    const point = position(piece)
    const tile = point ? tiles.get(cellKey(point.x, point.y)) : undefined
    if (!tile) return total
    const missingHealth = 1 - ratio(piece.currentHp, piece.maxHp)
    const healing = ratio(tile.props.healPerTurn ?? 0, piece.maxHp) * (1 + missingHealth)
    const damage = ratio(tile.props.damagePerTurn ?? 0, piece.maxHp) * (1 + missingHealth)
    const charge = Math.max(0, tile.props.chargePerTurn ?? 0) * 0.25
    const cover = tile.props.type === 'cover' ? 0.5 : 0
    return total + healing + charge + cover - damage
  }, 0)
}

function statusBalance(pieces: AIObservedPiece[]) {
  return pieces.reduce((total, piece) => {
    const buffs = new Set((piece.buffs ?? []).map(item => item.type))
    const debuffs = new Set((piece.debuffs ?? []).map(item => item.type))
    return total + buffs.size - debuffs.size
  }, 0)
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
  const ownDeploymentLocked = observation.deployment?.locks[observation.playerId]?.locked === true
  const enemyDeploymentLocks = observation.deployment?.playerIds.filter(playerId => (
    !samePlayer(playerId, observation.playerId)
    && observation.deployment?.locks[playerId]?.locked === true
  )).length ?? 0
  const raw: Record<ZeroStageStaticComponentKey, number> = {
    coreSurvival: own.filter(piece => piece.isCore).length - enemy.filter(piece => piece.isCore).length,
    survival: own.length - enemy.length,
    graveyard: enemyGraveyard - ownGraveyard,
    health: own.reduce((total, piece) => total + ratio(piece.currentHp, piece.maxHp), 0)
      - enemy.reduce((total, piece) => total + ratio(piece.currentHp, piece.maxHp), 0),
    combatPower: own.reduce((total, piece) => total + ratio(piece.attack + piece.defense, piece.maxHp), 0)
      - enemy.reduce((total, piece) => total + ratio(piece.attack + piece.defense, piece.maxHp), 0),
    shield: own.reduce((total, piece) => (
      total + ratio(Math.min(piece.maxHp, Math.max(0, piece.shield ?? 0)), piece.maxHp)
    ), 0) - enemy.reduce((total, piece) => (
      total + ratio(Math.min(piece.maxHp, Math.max(0, piece.shield ?? 0)), piece.maxHp)
    ), 0),
    resources: Math.max(0, (ownPlayer?.maxActionPoints ?? 0) - (ownPlayer?.actionPoints ?? 0))
      - (ownPlayer?.chargePoints ?? 0)
      - enemyPlayers.reduce((total, player) => (
        total + Math.max(0, player.maxActionPoints - player.actionPoints) - player.chargePoints
      ), 0),
    actionability: own.length + Math.min(3, ownPlayer?.actionPoints ?? 0)
      - enemy.length - Math.min(3, enemyPlayers.reduce((total, player) => total + player.actionPoints, 0)),
    deploymentReadiness: observation.deployment?.status === 'awaiting-locks'
      ? Number(ownDeploymentLocked) - enemyDeploymentLocks
      : 0,
    turnProgress: observation.turn.phase === 'action'
      ? (activeEnemy ? 1 : 0)
      : 0,
    lethalOpportunity: lethalOpportunities(own, enemy) - lethalOpportunities(enemy, own),
    attackPressure: attackPressure(own, enemy) - attackPressure(enemy, own),
    status: statusBalance(own) - statusBalance(enemy),
    positionSafety: dangerExposure(enemy, own) - dangerExposure(own, enemy),
    strategicPosition: strategicPosition(own, enemy, observation)
      - strategicPosition(enemy, own, observation),
    futureAttackPotential: futureAttackPotential(own, enemy) - futureAttackPotential(enemy, own),
    supportPotential: supportPotential(own) - supportPotential(enemy),
    mobilityPotential: mobilityPotential(own, observation) - mobilityPotential(enemy, observation),
    terrainValue: terrainValue(own, observation) - terrainValue(enemy, observation),
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
