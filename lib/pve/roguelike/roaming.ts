import type { BattleState } from '../../game/turn'
import { adventureBoundary, insideZone, type AdventureEnemyPlan } from '../../game/adventure-boundary'
import { getLegalNormalMoveTargets } from '../../game/spatial'
import type { RoguelikeAdventureV1 } from '../contracts/roguelike-content-v1'

const key = (x: number, y: number) => `${x},${y}`

/** Only surviving patrols may act outside encounters. Cleared patrols never respawn. */
export function initializeRoaming(state: BattleState, content: RoguelikeAdventureV1): void {
  const world = adventureBoundary(state)!
  world.roamingEnemyIds = [...(content.roaming?.enemyIds ?? [])]
  if (!world.activeZone) {
    world.activeEnemyIds = world.roamingEnemyIds.filter(id => state.pieces.some(p => p.instanceId === id && p.currentHp > 0))
    delete world.roamingEncounter
  }
}

/** A world-turn pursuit is published in advance, then executed by the native move command. */
export function planRoamingEnemies(state: BattleState, content: RoguelikeAdventureV1): AdventureEnemyPlan[] {
  const world = adventureBoundary(state)!, config = content.roaming
  if (!config || world.activeZone) return []
  const captain = state.pieces.find(p => p.instanceId === world.party?.captainId && p.currentHp > 0)
  if (!captain || captain.x === null || captain.y === null) return []
  const outside = (x: number, y: number) => !content.zones.some(z => insideZone(z, x, y))
  const floor = new Set(state.map.tiles.filter(t => t.props.walkable && outside(t.x, t.y)).map(t => key(t.x, t.y)))
  const distances = new Map<string, number>([[key(captain.x, captain.y), 0]])
  const queue = [{ x: captain.x, y: captain.y }]
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i], distance = distances.get(key(cell.x, cell.y))!
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = cell.x + dx, y = cell.y + dy, id = key(x, y)
      if (floor.has(id) && !distances.has(id)) { distances.set(id, distance + 1); queue.push({ x, y }) }
    }
  }
  const plans: AdventureEnemyPlan[] = [], destinations = new Set<string>()
  for (const p of state.pieces.filter(p => config.enemyIds.includes(p.instanceId) && p.currentHp > 0)) {
    if (p.x === null || p.y === null) continue
    const distance = distances.get(key(p.x, p.y)) ?? Infinity
    if (distance > config.aggroRange || distance <= 1) continue
    const moves = getLegalNormalMoveTargets(state, p).filter(c => floor.has(key(c.x, c.y)) && !destinations.has(key(c.x, c.y)))
      .sort((a, b) => (distances.get(key(a.x, a.y)) ?? Infinity) - (distances.get(key(b.x, b.y)) ?? Infinity) || a.y - b.y || a.x - b.x)
    const to = moves.find(c => (distances.get(key(c.x, c.y)) ?? Infinity) < distance)
    if (!to) continue
    // Native normal movement is straight; record every traversed cell for blocking validation.
    const dx = Math.sign(to.x - p.x), dy = Math.sign(to.y - p.y), cells = []
    const steps = Math.max(Math.abs(to.x - p.x), Math.abs(to.y - p.y))
    for (let n = 1; n <= steps; n++) cells.push({ x: p.x + dx * n, y: p.y + dy * n })
    if (cells.some(c => !floor.has(key(c.x, c.y)))) continue
    destinations.add(key(to.x, to.y))
    plans.push({ id: `patrol:${state.turn.turnNumber}:${p.instanceId}`, sourceId: p.instanceId, round: 0,
      kind: 'move', origin: { x: p.x, y: p.y }, cells,
      action: { type: 'move', playerId: p.ownerPlayerId, pieceId: p.instanceId, toX: to.x, toY: to.y } })
  }
  return plans
}

/** Adjacent patrols start a local encounter on a player's actionable turn, never gain a free opening hit. */
export function tryStartRoamingEncounter(state: BattleState, content: RoguelikeAdventureV1) {
  const world = adventureBoundary(state)!, config = content.roaming
  if (!config || world.activeZone || state.terminalResult || state.pendingOptionSelection || state.pendingTargetSelection
    || state.turn.currentPlayerId !== world.humanId || state.turn.phase !== 'action') return undefined
  const captain = state.pieces.find(p => p.instanceId === world.party?.captainId && p.currentHp > 0)
  if (!captain || captain.x === null || captain.y === null || content.zones.some(z => insideZone(z, captain.x, captain.y))) return undefined
  const foe = state.pieces.find(p => config.enemyIds.includes(p.instanceId) && p.currentHp > 0 && p.x !== null && p.y !== null
    && Math.abs(p.x - captain.x!) + Math.abs(p.y - captain.y!) <= 2)
  if (!foe) return undefined
  // Fit the largest local rectangle around both pieces without swallowing protected outposts.
  const sizes = []
  for (let width = Math.max(3, Math.abs(foe.x! - captain.x) + 1); width <= Math.min(14, state.map.width - 2); width++)
    for (let height = Math.max(3, Math.abs(foe.y! - captain.y) + 1); height <= Math.min(14, state.map.height - 2); height++) sizes.push({ width, height })
  sizes.sort((a, b) => b.width * b.height - a.width * a.height || Math.abs(a.width - a.height) - Math.abs(b.width - b.height))
  const floor = new Set(state.map.tiles.filter(t => t.props.walkable).map(t => key(t.x, t.y)))
  const connected = (candidate: { id: string; x: number; y: number; width: number; height: number }) => {
    const queue = [{ x: captain.x!, y: captain.y! }], seen = new Set([key(captain.x!, captain.y!)])
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i]
      if (p.x === foe.x && p.y === foe.y) return true
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const x = p.x + dx, y = p.y + dy, id = key(x, y)
        if (insideZone(candidate, x, y) && floor.has(id) && !seen.has(id)) { seen.add(id); queue.push({ x, y }) }
      }
    }
    return false
  }
  let area: { id: string; x: number; y: number; width: number; height: number } | undefined
  for (const size of sizes) {
    const candidates = []
    for (let y = Math.max(1, Math.max(captain.y, foe.y!) - size.height + 1); y <= Math.min(captain.y, foe.y!, state.map.height - size.height - 1); y++)
      for (let x = Math.max(1, Math.max(captain.x, foe.x!) - size.width + 1); x <= Math.min(captain.x, foe.x!, state.map.width - size.width - 1); x++) {
        if (content.zones.some(z => x < z.x + z.width && x + size.width > z.x && y < z.y + z.height && y + size.height > z.y)) continue
        candidates.push({ id: 'roaming-area', x, y, ...size })
      }
    candidates.sort((a, b) => Math.abs(a.x + a.width / 2 - captain.x!) + Math.abs(a.y + a.height / 2 - captain.y!)
      - Math.abs(b.x + b.width / 2 - captain.x!) - Math.abs(b.y + b.height / 2 - captain.y!) || a.y - b.y || a.x - b.x)
    const candidate = candidates.find(connected)
    if (candidate) { area = candidate; break }
  }
  if (!area) return undefined
  const enemies = state.pieces.filter(p => config.enemyIds.includes(p.instanceId) && p.currentHp > 0
    && insideZone(area!, p.x, p.y) && Math.abs(p.x! - captain.x!) + Math.abs(p.y! - captain.y!) <= config.aggroRange)
  const encounter = { ...area, id: `roaming-${enemies.map(p => p.instanceId).sort().join('-')}`, name: '巡游遭遇',
    enemyIds: enemies.map(p => p.instanceId), coreIds: enemies.map(p => p.instanceId), reward: config.reward * enemies.length, kind: 'roaming' as const }
  world.roamingEncounter = encounter
  world.activeZone = encounter
  world.activeEnemyIds = [...encounter.enemyIds]
  world.plans = []; delete world.plansTurn
  return encounter
}

export function getRoamingEncounter(state: BattleState) {
  const world = adventureBoundary(state)
  return world?.roamingEncounter?.id === world?.activeZone?.id ? world?.roamingEncounter : undefined
}
