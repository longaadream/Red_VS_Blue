import { resolveZeroStageConfig } from './ai-profiles'
import { DEPLOYMENT_FIRST_MOVE_FREE_STATUS } from './piece'
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
const healthValue = (piece: AIObservedPiece) => {
  const remaining = ratio(piece.currentHp, piece.maxHp)
  return piece.isCore ? Math.sqrt(remaining) * 6 : remaining * 0.25
}
const position = (piece: AIObservedPiece) => piece.x == null || piece.y == null ? undefined : { x: piece.x, y: piece.y }
const pointDistance = (left: { x: number; y: number }, right: { x: number; y: number }) => (
  Math.abs(left.x - right.x) + Math.abs(left.y - right.y)
)
const distance = (left: AIObservedPiece, right: AIObservedPiece) => {
  const a = position(left)
  const b = position(right)
  return a && b ? pointDistance(a, b) : Number.POSITIVE_INFINITY
}
const pursuitDistance = (source: AIObservedPiece, steps: number) => {
  const hasDeploymentFirstMoveFree = source.statusTags.some(tag => (
    tag.type === DEPLOYMENT_FIRST_MOVE_FREE_STATUS
    && (tag.currentUses ?? 1) > 0
  ))
  // Unused mobility is only potential; actually advancing should be worth more.
  return hasDeploymentFirstMoveFree
    ? Math.max(0, steps - Math.max(0, source.moveRange) * 0.5)
    : steps
}
const cellKey = (x: number, y: number) => `${x},${y}`

interface WalkableDistanceCache {
  walkable: Set<string>
  fields: Map<string, Map<string, number>>
}

const MAX_WALKABLE_TOPOLOGIES = 8
const walkableTopologyCache = new Map<string, WalkableDistanceCache>()

function walkableTopology(observation: AIObservation): WalkableDistanceCache {
  const walkableCells = observation.map.tiles
    .filter(tile => tile.props.walkable)
    .map(tile => cellKey(tile.x, tile.y))
    .sort()
  const topologyKey = `${observation.map.width}x${observation.map.height}|${walkableCells.join(';')}`
  const cached = walkableTopologyCache.get(topologyKey)
  if (cached) {
    // Refresh insertion order so a long-running evaluator keeps active maps.
    walkableTopologyCache.delete(topologyKey)
    walkableTopologyCache.set(topologyKey, cached)
    return cached
  }

  const created = { walkable: new Set(walkableCells), fields: new Map<string, Map<string, number>>() }
  walkableTopologyCache.set(topologyKey, created)
  if (walkableTopologyCache.size > MAX_WALKABLE_TOPOLOGIES) {
    const oldest = walkableTopologyCache.keys().next().value
    if (oldest !== undefined) walkableTopologyCache.delete(oldest)
  }
  return created
}

function createWalkableDistance(observation: AIObservation) {
  const { walkable, fields } = walkableTopology(observation)
  return (source: AIObservedPiece, target: AIObservedPiece) => {
    const start = position(source)
    const goal = position(target)
    if (!start || !goal) return Number.POSITIVE_INFINITY
    const goalKey = cellKey(goal.x, goal.y)
    let distances = fields.get(goalKey)
    if (!distances) {
      distances = new Map([[goalKey, 0]])
      const queue = [goal]
      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index]
        const steps = distances.get(cellKey(current.x, current.y)) ?? 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const next = { x: current.x + dx, y: current.y + dy }
          const key = cellKey(next.x, next.y)
          if (!walkable.has(key) || distances.has(key)) continue
          distances.set(key, steps + 1)
          queue.push(next)
        }
      }
      fields.set(goalKey, distances)
    }
    return distances.get(cellKey(start.x, start.y)) ?? Number.POSITIVE_INFINITY
  }
}

function engagement(source: AIObservedPiece, target: AIObservedPiece) {
  return distance(source, target) <= Math.max(1, source.moveRange + 1)
}

function lethalOpportunities(sources: AIObservedPiece[], targets: AIObservedPiece[]) {
  return targets.reduce((total, target) => {
    const threatened = sources.some(source => (
      engagement(source, target)
      && Math.max(1, source.attack - target.defense) >= target.currentHp
    ))
    return threatened ? total + (target.isCore ? 3 : 0.5) : total
  }, 0)
}

function attackPressure(sources: AIObservedPiece[], targets: AIObservedPiece[]) {
  return targets.reduce((total, target) => total + Math.max(0, ...sources.map(source => {
    if (!engagement(source, target)) return 0
    const damage = Math.max(1, source.attack - target.defense) / Math.max(1, target.maxHp)
    const finishPriority = 1 + (1 - ratio(target.currentHp, target.maxHp))
    const targetPriority = target.isCore ? 3 : 0.5
    return damage * finishPriority * targetPriority
  })), 0)
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
  return targets.reduce((total, target) => total + Math.max(0, ...sources.map(source => {
    const steps = pursuitDistance(source, distance(source, target))
    if (!Number.isFinite(steps)) return 0
    const projectedRange = Math.max(1, source.moveRange + 1)
    const proximity = projectedRange / Math.max(projectedRange, steps)
    const damage = Math.max(1, source.attack - target.defense) / Math.max(1, target.maxHp)
    const immediateCoverage = steps <= 1 ? 1 : 0
    const finishPriority = 1 + (1 - ratio(target.currentHp, target.maxHp)) * 0.5
    const targetPriority = target.isCore ? 3 : 0.5
    return targetPriority * finishPriority * (
      proximity * (0.5 + damage)
      + immediateCoverage * (1 + damage)
    )
  })), 0)
}

function enemyProximityPotential(
  sources: AIObservedPiece[],
  hostile: AIObservedPiece[],
  walkableDistance: ReturnType<typeof createWalkableDistance>,
  distanceScale: number,
) {
  const pursuers = sources.some(piece => piece.isCore) ? sources.filter(piece => piece.isCore) : sources
  const hostileCores = hostile.filter(piece => piece.isCore)
  const objectives = hostileCores.length > 0 ? hostileCores : hostile
  if (sources.length === 0 || objectives.length === 0) return 0
  const lateCleanup = hostileCores.length > 0
    && objectives.length <= 4
    && pursuers.length > objectives.length
  const pursuitDistanceScale = objectives.length === 1 && pursuers.length > objectives.length
    ? Math.max(1, Math.sqrt(distanceScale) * 2)
    : lateCleanup
      ? Math.max(1, Math.sqrt(distanceScale) * 4)
      : Math.max(1, distanceScale)
  const proximity = (source: AIObservedPiece, target: AIObservedPiece) => {
    const steps = pursuitDistance(source, walkableDistance(source, target))
    if (!Number.isFinite(steps)) return 0
    return 1 - Math.min(1, steps / pursuitDistanceScale)
  }
  const reachesStagingRange = (source: AIObservedPiece, target: AIObservedPiece) => {
    const steps = pursuitDistance(source, walkableDistance(source, target))
    const stagingRange = Math.max(1, source.moveRange + 1)
    return Number.isFinite(steps) && steps <= stagingRange
  }
  const nearestSum = sources.reduce((total, source) => {
    return total + Math.max(0, ...objectives.map(target => proximity(source, target)))
  }, 0)
  const assignmentWeight = hostileCores.length > 0 && pursuers.length > objectives.length
    ? Math.min(0.5, objectives.length / pursuers.length)
    : 0
  const stagingCoverage = lateCleanup
    ? pursuers.reduce((total, source) => (
        total + Number(objectives.some(target => reachesStagingRange(source, target))) * 0.05
      ), 0)
    : 0
  if (assignmentWeight === 0) return nearestSum + stagingCoverage

  // Once the enemy is deeply outnumbered, assign every surviving core to an
  // objective with a balanced per-target capacity. The former one-to-one blend
  // guaranteed only one pursuer per remote survivor; everybody else could keep
  // following the nearest target and leave a healer or shielded core in an
  // endless one-on-one. A ceil(N/M) capacity forces N pursuers to distribute as
  // evenly as possible while still choosing the cheapest assignment globally.
  if (objectives.length * 2 <= pursuers.length) {
    const capacity = Math.ceil(pursuers.length / objectives.length)
    const memo = new Map<string, number>()
    const bestBalancedAssignment = (sourceIndex: number, targetUses: number[]): number => {
      if (sourceIndex >= pursuers.length) return 0
      const memoKey = `${sourceIndex}|${targetUses.join(',')}`
      const cached = memo.get(memoKey)
      if (cached !== undefined) return cached
      let best = Number.NEGATIVE_INFINITY
      for (let targetIndex = 0; targetIndex < objectives.length; targetIndex += 1) {
        if (targetUses[targetIndex] >= capacity) continue
        targetUses[targetIndex] += 1
        best = Math.max(
          best,
          proximity(pursuers[sourceIndex], objectives[targetIndex])
            + bestBalancedAssignment(sourceIndex + 1, targetUses),
        )
        targetUses[targetIndex] -= 1
      }
      memo.set(memoKey, best)
      return best
    }
    const pursuerIds = new Set(pursuers.map(piece => piece.instanceId))
    const supportingNearest = sources.reduce((total, source) => (
      pursuerIds.has(source.instanceId)
        ? total
        : total + Math.max(0, ...objectives.map(target => proximity(source, target)))
    ), 0)
    // Assignment prevents abandoned objectives; this target-independent bonus
    // separately rewards every pursuer that can stage against any survivor.
    // It avoids a globally optimal assignment label making a nearby actionable
    // enemy look irrelevant to that pursuer.
    return supportingNearest
      + bestBalancedAssignment(0, objectives.map(() => 0))
      + stagingCoverage
  }

  // Match the smaller side one-to-one against the larger side. A nearest-only
  // sum lets the whole team crowd one nearby core while ignoring survivors on
  // the other side of the map. Matching preserves the smooth distance signal
  // while assigning distinct pursuers whenever enough core pieces remain.
  const rows = pursuers.length <= objectives.length ? pursuers : objectives
  const columns = pursuers.length <= objectives.length ? objectives : pursuers
  const assignmentProximity = rows.map(row => columns.map(column => {
    const source = pursuers.length <= objectives.length ? row : column
    const target = pursuers.length <= objectives.length ? column : row
    return proximity(source, target)
  }))
  const memo = new Map<number, number>()
  const bestAssignment = (rowIndex: number, usedColumns: number): number => {
    if (rowIndex >= rows.length) return 0
    const memoKey = rowIndex * (2 ** columns.length) + usedColumns
    const cached = memo.get(memoKey)
    if (cached !== undefined) return cached
    let best = 0
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const bit = 2 ** columnIndex
      if (Math.floor(usedColumns / bit) % 2 === 1) continue
      best = Math.max(
        best,
        assignmentProximity[rowIndex][columnIndex] + bestAssignment(rowIndex + 1, usedColumns + bit),
      )
    }
    memo.set(memoKey, best)
    return best
  }
  // Keep the component magnitude comparable to the former per-pursuer sum
  // when there are more pursuers than objectives.
  const assigned = bestAssignment(0, 0) * pursuers.length / rows.length
  return nearestSum * (1 - assignmentWeight) + assigned * assignmentWeight + stagingCoverage
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
    const explicitTypes = new Set([...buffs, ...debuffs])
    const sourcedTags = piece.statusTags.reduce((subtotal, tag) => {
      if (!tag.sourcePlayerId || explicitTypes.has(tag.type)) return subtotal
      return subtotal + (samePlayer(tag.sourcePlayerId, piece.ownerPlayerId) ? 1 : -1)
    }, 0)
    return total + buffs.size - debuffs.size + sourcedTags
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
  const activeOwn = observation.turn.phase === 'action'
    && samePlayer(observation.turn.currentPlayerId, observation.playerId)
  const activeEnemy = observation.turn.phase === 'action' && !activeOwn
  const ownDeploymentLocked = observation.deployment?.locks[observation.playerId]?.locked === true
  const enemyDeploymentLocks = observation.deployment?.playerIds.filter(playerId => (
    !samePlayer(playerId, observation.playerId)
    && observation.deployment?.locks[playerId]?.locked === true
  )).length ?? 0
  const walkableDistance = createWalkableDistance(observation)
  const distanceScale = Math.max(1, observation.map.tiles.filter(tile => tile.props.walkable).length - 1)
  const raw: Record<ZeroStageStaticComponentKey, number> = {
    coreSurvival: own.filter(piece => piece.isCore).length - enemy.filter(piece => piece.isCore).length,
    survival: own.length - enemy.length,
    graveyard: enemyGraveyard - ownGraveyard,
    health: own.reduce((total, piece) => total + healthValue(piece), 0)
      - enemy.reduce((total, piece) => total + healthValue(piece), 0),
    combatPower: own.reduce((total, piece) => total + ratio(piece.attack + piece.defense, piece.maxHp), 0)
      - enemy.reduce((total, piece) => total + ratio(piece.attack + piece.defense, piece.maxHp), 0),
    shield: own.reduce((total, piece) => (
      total + ratio(Math.min(piece.maxHp, Math.max(0, piece.shield ?? 0)), piece.maxHp)
    ), 0) - enemy.reduce((total, piece) => (
      total + ratio(Math.min(piece.maxHp, Math.max(0, piece.shield ?? 0)), piece.maxHp)
    ), 0),
    // AP and charge are means, not outcomes. Their value is represented by the
    // health, material, pressure, safety, and position created after spending them.
    resources: 0,
    actionability: own.length - enemy.length,
    deploymentReadiness: observation.deployment?.status === 'awaiting-locks'
      ? Number(ownDeploymentLocked) - enemyDeploymentLocks
      : 0,
    turnProgress: observation.turn.phase === 'action'
      ? (activeEnemy ? 1 : 0)
      : 0,
    lethalOpportunity: lethalOpportunities(own, enemy) - lethalOpportunities(enemy, own),
    attackPressure: attackPressure(own, enemy) - attackPressure(enemy, own),
    status: statusBalance(own) - statusBalance(enemy),
    positionSafety: -dangerExposure(own, enemy),
    strategicPosition: strategicPosition(own, enemy, observation)
      - strategicPosition(enemy, own, observation),
    // Initiative is player-relative rather than zero-sum: when the active side
    // closes one step, the geometrically mirrored enemy distance changes too.
    // Subtracting both directions would cancel the exact pursuit signal.
    enemyProximity: observation.deployment?.status === 'awaiting-locks'
      ? 0
      : enemyProximityPotential(own, enemy, walkableDistance, distanceScale),
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
