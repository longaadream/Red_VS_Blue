import { DEPLOYMENT_FIRST_MOVE_FREE_STATUS } from './piece'
import { areMatchAllies, type MatchTeam } from './match-teams'

export interface GridPosition {
  x: number
  y: number
}

export interface NullableGridPosition {
  x?: number | null
  y?: number | null
}

export interface GridBounds {
  width: number
  height: number
}

export interface SpatialTile extends GridPosition {
  props?: {
    walkable?: boolean
    bulletPassable?: boolean
    /** Legacy alias retained while map data is migrated. */
    bullet?: boolean
    type?: string
  }
}

export interface SpatialMap extends GridBounds {
  tiles: readonly SpatialTile[]
}

export interface SpatialPiece {
  instanceId?: string
  ownerPlayerId?: string
  x?: number | null
  y?: number | null
  currentHp: number
  moveRange?: number | null
  statusTags?: ReadonlyArray<{
    type?: string
    grantedTurnNumber?: unknown
    currentUses?: unknown
    blocksForcedMovement?: unknown
  }>
}

export interface SpatialBattleState {
  players?: readonly { playerId: string; teamId?: MatchTeam }[]
  extensions?: { tileEffects?: Array<{ type?: string; x?: number; y?: number; blocksLanding?: boolean }>; [key: string]: unknown }
  map: SpatialMap
  pieces: readonly SpatialPiece[]
}

export type PositionChangeKind = 'walk' | 'dash' | 'teleport' | 'push' | 'pull' | 'swap'

/** Leaving play and entering play are lifecycle operations, not board movement. */
export function getPositionChangeRejection(piece: SpatialPiece, kind: PositionChangeKind): string | null {
  const tags = Array.isArray(piece.statusTags) ? piece.statusTags : []
  if (tags.some(tag => tag.type === 'imprisoned' || tag.blocksForcedMovement === true)) {
    return '棋子被禁锢，不能改变棋盘位置'
  }
  if (kind === 'walk' && tags.some(tag => tag.type === 'root')) {
    return '棋子被定身，不能主动走格'
  }
  return null
}

/**
 * Skill displacement deliberately has different path rules from normal moves,
 * but every successful landing shares these board invariants.
 */
export interface SkillLandingOptions {
  /** Pieces moved by the same atomic effect are treated as vacating their old cells. */
  movingPieceIds?: readonly string[]
  /** Cells already promised to an earlier or enclosing effect in the same action. */
  reservedCells?: readonly GridPosition[]
}

export interface ProjectileTraceOptions {
  /** Do not report the firing piece as a collision if the origin is occupied. */
  excludePieceId?: string
  /** Optional range cap. Omit to trace until the first board boundary. */
  maxDistance?: number
}

export type ProjectileTraceEvent<
  TTile extends SpatialTile = SpatialTile,
  TPiece extends SpatialPiece = SpatialPiece,
> =
  | { type: 'cell'; x: number; y: number; distance: number; tile: TTile }
  | { type: 'piece'; x: number; y: number; distance: number; piece: TPiece }
  | { type: 'terrain'; x: number; y: number; distance: number; tile: TTile; blocksProjectile: boolean }
  | { type: 'boundary'; x: number; y: number; distance: number }

export interface NormalMoveActionState extends SpatialBattleState {
  players: ReadonlyArray<{
    playerId: string
    actionPoints: number
  }>
  turn: {
    currentPlayerId: string
    phase: string
    turnNumber: number
  }
}

export type NormalMoveRejectionCode =
  | 'movement-restricted'
  | 'piece-not-on-board'
  | 'target-outside-board'
  | 'not-orthogonal'
  | 'same-position'
  | 'invalid-move-range'
  | 'out-of-range'
  | 'terrain-blocked'
  | 'piece-blocked'
  | 'target-occupied'
  | 'malformed-path'
  | 'nonadjacent-path'
  | 'repeated-path'
  | 'path-blocked'

export interface NormalMoveRejection {
  code: NormalMoveRejectionCode
  message: string
  at?: GridPosition
}

export type NormalMovePath = readonly GridPosition[]

const ORTHOGONAL_DIRECTIONS: readonly GridPosition[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
]

export function gridPositionKey(position: GridPosition): string {
  return `${position.x},${position.y}`
}

export function manhattanDistance(from: NullableGridPosition, to: NullableGridPosition): number {
  if (from.x == null || from.y == null || to.x == null || to.y == null) {
    throw new RangeError('Manhattan distance requires two on-board positions')
  }
  return Math.abs(from.x - to.x) + Math.abs(from.y - to.y)
}

export function isInsideBounds(position: GridPosition, bounds: GridBounds): boolean {
  return position.x >= 0
    && position.x < bounds.width
    && position.y >= 0
    && position.y < bounds.height
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`)
  }
}

/** 默认“距离 N 格/周围 N 格”：曼哈顿距离不超过 range。 */
export function getManhattanArea(
  center: GridPosition,
  range: number,
  bounds?: GridBounds,
): GridPosition[] {
  assertNonNegativeInteger(range, 'range')
  const cells: GridPosition[] = []
  for (let yOffset = -range; yOffset <= range; yOffset++) {
    const remaining = range - Math.abs(yOffset)
    for (let xOffset = -remaining; xOffset <= remaining; xOffset++) {
      const cell = { x: center.x + xOffset, y: center.y + yOffset }
      if (!bounds || isInsideBounds(cell, bounds)) cells.push(cell)
    }
  }
  return cells
}

/** 明确的方形范围；radius=1 表示以 center 为中心的 3×3 区域。 */
export function getSquareArea(
  center: GridPosition,
  radius: number,
  bounds?: GridBounds,
): GridPosition[] {
  assertNonNegativeInteger(radius, 'radius')
  const cells: GridPosition[] = []
  for (let yOffset = -radius; yOffset <= radius; yOffset++) {
    for (let xOffset = -radius; xOffset <= radius; xOffset++) {
      const cell = { x: center.x + xOffset, y: center.y + yOffset }
      if (!bounds || isInsideBounds(cell, bounds)) cells.push(cell)
    }
  }
  return cells
}

/**
 * 返回从起点之后到终点（含终点）的横向或纵向格序列。
 * 斜线返回 null，同点返回空序列。
 */
export function getOrthogonalLineCells(
  from: GridPosition,
  to: GridPosition,
): GridPosition[] | null {
  if (from.x !== to.x && from.y !== to.y) return null
  if (from.x === to.x && from.y === to.y) return []

  const stepX = Math.sign(to.x - from.x)
  const stepY = Math.sign(to.y - from.y)
  const cells: GridPosition[] = []
  let x = from.x + stepX
  let y = from.y + stepY
  while (x !== to.x || y !== to.y) {
    cells.push({ x, y })
    x += stepX
    y += stepY
  }
  cells.push({ x: to.x, y: to.y })
  return cells
}

export function getLivingOccupantAt<TPiece extends SpatialPiece>(
  pieces: readonly TPiece[],
  position: GridPosition,
  excludeInstanceId?: string,
): TPiece | undefined {
  return pieces.find(piece => piece.currentHp > 0
    && piece.x === position.x
    && piece.y === position.y
    && (excludeInstanceId === undefined || piece.instanceId !== excludeInstanceId))
}

export function isLegalSkillLanding(
  state: SpatialBattleState,
  position: GridPosition,
  options: SkillLandingOptions = {},
): boolean {
  if (!Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y) || !isInsideBounds(position, state.map)) return false
  if ((options.movingPieceIds ?? []).some(id => {
    const piece = state.pieces.find(candidate => candidate.instanceId === id)
    return piece && getPositionChangeRejection(piece, 'teleport') !== null
  })) return false
  const tile = state.map.tiles.find(candidate => candidate.x === position.x && candidate.y === position.y)
  if (!tile?.props?.walkable) return false

  const reserved = new Set((options.reservedCells ?? []).map(gridPositionKey))
  for (const effect of state.extensions?.tileEffects ?? []) {
    if (effect.blocksLanding
      && effect.x != null && effect.y != null) reserved.add(gridPositionKey({ x: effect.x, y: effect.y }))
  }
  if (reserved.has(gridPositionKey(position))) return false

  const movingPieceIds = new Set(options.movingPieceIds ?? [])
  return !state.pieces.some(piece => piece.currentHp > 0
    && piece.x === position.x
    && piece.y === position.y
    && !movingPieceIds.has(String(piece.instanceId ?? '')))
}

/** Stable filtering: preserves authored candidate priority and removes duplicates. */
export function getLegalSkillLandingCells(
  state: SpatialBattleState,
  candidates: readonly GridPosition[],
  options: SkillLandingOptions = {},
): GridPosition[] {
  const seen = new Set<string>()
  return candidates.filter(candidate => {
    const key = gridPositionKey(candidate)
    if (seen.has(key)) return false
    seen.add(key)
    return isLegalSkillLanding(state, candidate, options)
  })
}

/** Exact destinations cancel when the one requested cell is no longer legal. */
export function resolveExactSkillLanding(
  state: SpatialBattleState,
  destination: GridPosition,
  options: SkillLandingOptions = {},
): GridPosition | undefined {
  return isLegalSkillLanding(state, destination, options) ? { ...destination } : undefined
}

/** Nearby/random effects can supply their deterministic priority order and take the first legal cell. */
export function resolveOrderedSkillLanding(
  state: SpatialBattleState,
  candidates: readonly GridPosition[],
  options: SkillLandingOptions = {},
): GridPosition | undefined {
  const [landing] = getLegalSkillLandingCells(state, candidates, options)
  return landing ? { ...landing } : undefined
}

/**
 * Allocates a complete formation or nothing. Partial movement is never committed.
 * Candidate order and mover order are both authoritative and deterministic.
 */
export function allocateSkillFormation(
  state: SpatialBattleState,
  movingPieceIds: readonly string[],
  candidates: readonly GridPosition[],
  options: Omit<SkillLandingOptions, 'movingPieceIds'> = {},
): GridPosition[] | undefined {
  const legal = getLegalSkillLandingCells(state, candidates, { ...options, movingPieceIds })
  if (legal.length < movingPieceIds.length) return undefined
  return legal.slice(0, movingPieceIds.length).map(position => ({ ...position }))
}

/**
 * Return deterministic projectile facts without deciding any skill effect.
 *
 * Each in-bounds position emits a cell fact, every living occupant in battle
 * order, then its terrain fact. This intentional ordering lets an occupant on
 * cover receive a collision opportunity before the cover's blocking fact.
 * Tracing continues after all facts; the skill decides when to stop, pierce,
 * bounce, explode, damage allies, or ignore terrain.
 */
export function traceProjectile<
  TTile extends SpatialTile,
  TPiece extends SpatialPiece,
>(
  state: {
    map: GridBounds & { tiles: readonly TTile[] }
    pieces: readonly TPiece[]
  },
  origin: GridPosition,
  direction: GridPosition,
  options: ProjectileTraceOptions = {},
): ProjectileTraceEvent<TTile, TPiece>[] {
  if (!isInsideBounds(origin, state.map)) {
    throw new RangeError('Projectile origin must be inside the board')
  }
  if (!Number.isInteger(direction.x) || !Number.isInteger(direction.y)
    || Math.abs(direction.x) + Math.abs(direction.y) !== 1) {
    throw new RangeError('Projectile direction must be one cardinal unit vector')
  }
  if (options.maxDistance !== undefined) {
    assertNonNegativeInteger(options.maxDistance, 'maxDistance')
  }

  const events: ProjectileTraceEvent<TTile, TPiece>[] = []
  for (let distance = 1; options.maxDistance === undefined || distance <= options.maxDistance; distance += 1) {
    const x = origin.x + direction.x * distance
    const y = origin.y + direction.y * distance
    if (!isInsideBounds({ x, y }, state.map)) {
      events.push({ type: 'boundary', x, y, distance })
      break
    }

    const tile = state.map.tiles.find(candidate => candidate.x === x && candidate.y === y)
    if (!tile) throw new RangeError(`Projectile trace map is missing tile (${x},${y})`)

    events.push({ type: 'cell', x, y, distance, tile })
    for (const piece of state.pieces) {
      if (piece.currentHp > 0
        && piece.x === x
        && piece.y === y
        && piece.instanceId !== options.excludePieceId) {
        events.push({ type: 'piece', x, y, distance, piece })
      }
    }

    const blocksProjectile = isProjectileTerrainBlocked(tile)
    events.push({ type: 'terrain', x, y, distance, tile, blocksProjectile })
  }
  return events
}

function isProjectileTerrainBlocked(tile: SpatialTile): boolean {
  const explicitPassable = tile.props?.bulletPassable ?? tile.props?.bullet
  return typeof explicitPassable === 'boolean' ? !explicitPassable : tile.props?.type === 'wall' || tile.props?.type === 'cover'
}

interface NormalMoveSearchContext {
  walkable: Set<string>
  occupied: Set<string>
}

function isSafeGridPosition(value: unknown): value is GridPosition {
  if (!value || typeof value !== 'object') return false
  const position = value as NullableGridPosition
  return Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y)
}

function normalMoveRange(piece: SpatialPiece): number | undefined {
  if (typeof piece.moveRange !== 'number' || !Number.isFinite(piece.moveRange) || piece.moveRange < 0) return undefined
  return Math.floor(piece.moveRange)
}

function createNormalMoveSearchContext(
  state: SpatialBattleState,
  piece: SpatialPiece,
): NormalMoveSearchContext {
  const walkable = new Set(state.map.tiles
    .filter(tile => tile.props?.walkable === true)
    .map(gridPositionKey))
  const occupied = new Set(state.pieces
    .filter(candidate => candidate.currentHp > 0 && candidate.instanceId !== piece.instanceId
      && isSafeGridPosition({ x: candidate.x, y: candidate.y }))
    .map(candidate => gridPositionKey({ x: candidate.x!, y: candidate.y! })))
  return { walkable, occupied }
}

function isNormalMoveCellOpen(
  state: SpatialBattleState,
  position: GridPosition,
  context: NormalMoveSearchContext,
): boolean {
  return isInsideBounds(position, state.map)
    && context.walkable.has(gridPositionKey(position))
    && !context.occupied.has(gridPositionKey(position))
}

/** Find a shortest cardinal segment while excluding already committed route cells. */
function findNormalMoveSegment(
  state: SpatialBattleState,
  from: GridPosition,
  target: GridPosition,
  maxDistance: number,
  context: NormalMoveSearchContext,
  excluded: ReadonlySet<string>,
): GridPosition[] | null {
  if (from.x === target.x && from.y === target.y) return []
  if (maxDistance <= 0 || excluded.has(gridPositionKey(target))
    || !isNormalMoveCellOpen(state, target, context)) return null

  const queue: Array<{ position: GridPosition; path: GridPosition[] }> = [{ position: { ...from }, path: [] }]
  const visited = new Set(excluded)
  visited.add(gridPositionKey(from))
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (current.path.length >= maxDistance) continue
    for (const direction of ORTHOGONAL_DIRECTIONS) {
      const next = {
        x: current.position.x + direction.x,
        y: current.position.y + direction.y,
      }
      const key = gridPositionKey(next)
      if (visited.has(key) || !isNormalMoveCellOpen(state, next, context)) continue
      const path = [...current.path, next]
      if (next.x === target.x && next.y === target.y) return path
      visited.add(key)
      queue.push({ position: next, path })
    }
  }
  return null
}

function sameGridPosition(left: GridPosition, right: GridPosition): boolean {
  return left.x === right.x && left.y === right.y
}

/** Manhattan distance is an admissible lower bound for an ordered checkpoint route. */
function normalMoveWaypointLowerBound(
  current: GridPosition,
  destinations: readonly GridPosition[],
  nextDestinationIndex: number,
): number {
  let lowerBound = 0
  let cursor = current
  for (let index = nextDestinationIndex; index < destinations.length; index += 1) {
    lowerBound += manhattanDistance(cursor, destinations[index])
    cursor = destinations[index]
  }
  return lowerBound
}

/**
 * Search all bounded simple routes through ordered waypoints.  A greedy
 * shortest segment can consume the only corridor needed by a later segment,
 * so waypoint routes use deterministic iterative-deepening backtracking.
 * A shared node budget keeps malformed or hostile inputs bounded across all
 * depth iterations; an exhausted search returns null rather than silently
 * dropping a waypoint.
 */
function findNormalMoveWaypointPath(
  state: SpatialBattleState,
  origin: GridPosition,
  destinations: readonly GridPosition[],
  maxDistance: number,
  context: NormalMoveSearchContext,
): GridPosition[] | null {
  const lowerBound = normalMoveWaypointLowerBound(origin, destinations, 0)
  const availableCells = [...context.walkable].filter(key => !context.occupied.has(key)).length
  // A simple route cannot consume the origin twice. This also makes a huge
  // edited moveRange harmless on a finite board before iterative deepening.
  const boundedMaxDistance = Math.min(maxDistance, Math.max(0, availableCells - 1))
  if (lowerBound > boundedMaxDistance) return null

  const boardArea = Math.max(1, state.map.width * state.map.height)
  const nodeBudget = Math.min(100_000, Math.max(20_000, boardArea * 16))
  let exploredNodes = 0
  for (let depthLimit = lowerBound; depthLimit <= boundedMaxDistance; depthLimit += 1) {
    const used = new Set<string>([gridPositionKey(origin)])
    const route: GridPosition[] = []

    const search = (
      current: GridPosition,
      nextDestinationIndex: number,
      remaining: number,
    ): boolean => {
      exploredNodes += 1
      if (exploredNodes > nodeBudget) return false

      while (nextDestinationIndex < destinations.length
        && sameGridPosition(current, destinations[nextDestinationIndex])) {
        nextDestinationIndex += 1
      }
      if (nextDestinationIndex >= destinations.length) return true
      if (remaining <= 0
        || normalMoveWaypointLowerBound(current, destinations, nextDestinationIndex) > remaining) return false

      for (const direction of ORTHOGONAL_DIRECTIONS) {
        const next = { x: current.x + direction.x, y: current.y + direction.y }
        const nextKey = gridPositionKey(next)
        if (used.has(nextKey) || !isNormalMoveCellOpen(state, next, context)) continue

        // A later checkpoint cannot be crossed before the current one: it
        // would be marked used and could never be visited in order afterward.
        if (destinations.slice(nextDestinationIndex + 1).some(destination => sameGridPosition(destination, next))) continue

        used.add(nextKey)
        route.push({ ...next })
        if (search(next, nextDestinationIndex, remaining - 1)) return true
        route.pop()
        used.delete(nextKey)
        if (exploredNodes > nodeBudget) return false
      }
      return false
    }

    if (search(origin, 0, depthLimit)) return route.map(cell => ({ ...cell }))
    if (exploredNodes > nodeBudget) return null
  }
  return null
}

/**
 * Resolve the shortest legal normal route. Waypoints are mandatory ordered
 * checkpoints; each segment is searched with the cells already used by the
 * route excluded, so the returned route never revisits its origin or a prior
 * route cell.
 */
export function getNormalMovePath(
  state: SpatialBattleState,
  piece: SpatialPiece,
  target: GridPosition,
  waypoints: readonly GridPosition[] = [],
): GridPosition[] | null {
  if (!Array.isArray(waypoints) || !isSafeGridPosition(target)
    || piece.x == null || piece.y == null
    || !isSafeGridPosition({ x: piece.x, y: piece.y })) return null
  if (getPositionChangeRejection(piece, 'walk')) return null
  const range = normalMoveRange(piece)
  if (range === undefined || !isInsideBounds(target, state.map)) return null
  const origin = { x: piece.x, y: piece.y }
  if (!isInsideBounds(origin, state.map)) return null
  const destinations = [...waypoints, target]
  // A waypoint equal to the final target is already satisfied by landing on
  // that target; avoid treating this harmless duplicate as a revisit.
  if (destinations.length > 1
    && sameGridPosition(destinations[destinations.length - 2], target)) destinations.pop()
  const destinationKeys = new Set<string>()
  for (const destination of destinations) {
    if (!isSafeGridPosition(destination) || !isInsideBounds(destination, state.map)) return null
    const destinationKey = gridPositionKey(destination)
    if (sameGridPosition(destination, origin) || destinationKeys.has(destinationKey)) return null
    destinationKeys.add(destinationKey)
  }
  const context = createNormalMoveSearchContext(state, piece)
  if (destinations.some(destination => !isNormalMoveCellOpen(state, destination, context))) return null
  if (destinations.length === 1) {
    const segment = findNormalMoveSegment(state, origin, destinations[0], range, context, new Set([gridPositionKey(origin)]))
    return segment?.map(cell => ({ ...cell })) ?? null
  }
  return findNormalMoveWaypointPath(state, origin, destinations, range, context)
}

function validateExplicitNormalMovePath(
  state: SpatialBattleState,
  piece: SpatialPiece,
  target: GridPosition,
  path: unknown,
  maxRange: number,
  context: NormalMoveSearchContext,
): NormalMoveRejection | null {
  if (!Array.isArray(path) || path.length === 0) {
    return { code: 'malformed-path', message: 'Normal move path must contain the destination', at: target }
  }
  const last = path[path.length - 1]
  if (!isSafeGridPosition(last) || last.x !== target.x || last.y !== target.y) {
    return { code: 'malformed-path', message: 'Normal move path must end at the requested destination', at: target }
  }

  const origin = { x: piece.x!, y: piece.y! }
  let previous = origin
  const seen = new Set<string>([gridPositionKey(origin)])
  for (let index = 0; index < path.length; index += 1) {
    const cell = path[index]
    if (!isSafeGridPosition(cell)) {
      return { code: 'malformed-path', message: 'Normal move path cells must use safe integer coordinates' }
    }
    if (!isInsideBounds(cell, state.map)) {
      return { code: 'malformed-path', message: 'Normal move path leaves the board', at: cell }
    }
    const key = gridPositionKey(cell)
    if (seen.has(key)) {
      return { code: 'repeated-path', message: 'Normal move path cannot revisit a cell', at: cell }
    }
    if (manhattanDistance(previous, cell) !== 1) {
      return { code: 'nonadjacent-path', message: 'Normal move path must use adjacent cardinal cells', at: cell }
    }
    if (index + 1 > maxRange) {
      return { code: 'out-of-range', message: 'Normal move path exceeds piece moveRange', at: cell }
    }
    if (!context.walkable.has(key)) {
      return { code: 'terrain-blocked', message: 'Path is blocked by unwalkable terrain', at: cell }
    }
    if (context.occupied.has(key)) {
      const isTarget = index === path.length - 1
      return {
        code: isTarget ? 'target-occupied' : 'piece-blocked',
        message: isTarget ? 'Target tile is already occupied' : 'Path is blocked by a living piece',
        at: cell,
      }
    }
    seen.add(key)
    previous = cell
  }
  return null
}

export function getNormalMoveRejection(
  state: SpatialBattleState,
  piece: SpatialPiece,
  target: GridPosition,
  path?: NormalMovePath | null,
): NormalMoveRejection | null {
  const restriction = getPositionChangeRejection(piece, 'walk')
  if (restriction) return { code: 'movement-restricted', message: restriction }
  if (piece.x == null || piece.y == null || !isSafeGridPosition({ x: piece.x, y: piece.y })) {
    return { code: 'piece-not-on-board', message: 'Piece is not on the board' }
  }
  if (!isSafeGridPosition(target) || !isInsideBounds(target, state.map)) {
    return { code: 'target-outside-board', message: 'Target position is outside of the board', at: target }
  }

  const from = { x: piece.x, y: piece.y }
  if (from.x === target.x && from.y === target.y) {
    return { code: 'same-position', message: 'Move must change the piece position', at: target }
  }

  const maxRange = normalMoveRange(piece)
  if (maxRange === undefined) {
    return { code: 'invalid-move-range', message: 'Piece has an invalid moveRange' }
  }
  const context = createNormalMoveSearchContext(state, piece)
  if (path !== undefined) {
    return validateExplicitNormalMovePath(state, piece, target, path, maxRange, context)
  }

  if (manhattanDistance(from, target) > maxRange) {
    return { code: 'out-of-range', message: 'Move distance exceeds piece moveRange', at: target }
  }
  if (!context.walkable.has(gridPositionKey(target))) {
    return { code: 'terrain-blocked', message: 'Path is blocked by unwalkable terrain', at: target }
  }
  if (context.occupied.has(gridPositionKey(target))) {
    return { code: 'target-occupied', message: 'Target tile is already occupied', at: target }
  }
  if (!getNormalMovePath(state, piece, target)) {
    const line = getOrthogonalLineCells(from, target)
    if (line) {
      for (const cell of line) {
        if (!context.walkable.has(gridPositionKey(cell))) {
          return { code: 'terrain-blocked', message: 'Path is blocked by unwalkable terrain', at: cell }
        }
        if (context.occupied.has(gridPositionKey(cell))) {
          return { code: 'piece-blocked', message: 'Path is blocked by a living piece', at: cell }
        }
      }
    }
    return { code: 'path-blocked', message: 'No legal cardinal path reaches the requested destination; path is blocked', at: target }
  }
  return null
}

export function getLegalNormalMoveTargets(
  state: SpatialBattleState,
  piece: SpatialPiece,
): GridPosition[] {
  if (getPositionChangeRejection(piece, 'walk')) return []
  if (piece.x == null || piece.y == null || !isSafeGridPosition({ x: piece.x, y: piece.y })) return []
  const maxRange = normalMoveRange(piece)
  if (maxRange === undefined || maxRange <= 0) return []
  const origin = { x: piece.x, y: piece.y }
  const context = createNormalMoveSearchContext(state, piece)
  const visited = new Set<string>([gridPositionKey(origin)])
  const queue: Array<{ position: GridPosition; distance: number }> = [{ position: origin, distance: 0 }]
  const targets: GridPosition[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (current.distance >= maxRange) continue
    for (const direction of ORTHOGONAL_DIRECTIONS) {
      const target = {
        x: current.position.x + direction.x,
        y: current.position.y + direction.y,
      }
      const targetKey = gridPositionKey(target)
      if (visited.has(targetKey) || !isNormalMoveCellOpen(state, target, context)) continue
      visited.add(targetKey)
      const distance = current.distance + 1
      queue.push({ position: target, distance })
      if (isLegalSkillLanding(state, target, { movingPieceIds: piece.instanceId ? [piece.instanceId] : [] })) {
        targets.push(target)
      }
    }
  }
  return targets
}

/** 完整普通移动动作上下文的 UI/服务端候选集合（阶段、回合、所有权和 AP 均有效）。 */
export function getLegalNormalMoveTargetsForPlayer(
  state: NormalMoveActionState,
  playerId: string,
  pieceId: string,
): GridPosition[] {
  const normalizedPlayerId = playerId.toLowerCase()
  if (state.turn.phase !== 'action' || state.turn.currentPlayerId.toLowerCase() !== normalizedPlayerId) {
    return []
  }
  const player = state.players.find(candidate => candidate.playerId.toLowerCase() === normalizedPlayerId)
  if (!player) return []

  const piece = state.pieces.find(candidate => candidate.instanceId === pieceId
    && candidate.ownerPlayerId?.toLowerCase() === normalizedPlayerId
    && candidate.currentHp > 0)
  if (!piece) return []
  const hasCurrentTurnDeploymentFirstMoveFree = piece.statusTags?.some(statusTag =>
    statusTag.type === DEPLOYMENT_FIRST_MOVE_FREE_STATUS
      && statusTag.grantedTurnNumber === state.turn.turnNumber
      && statusTag.currentUses === 1) === true
  if (player.actionPoints < 1 && !hasCurrentTurnDeploymentFirstMoveFree) return []
  return getLegalNormalMoveTargets(state, piece)
}

export interface MovementTraceOptions {
  excludePieceId?: string
  maxDistance: number
  passAllies?: boolean
  passEnemies?: boolean
  terrain?: 'walkable' | 'projectile' | 'any'
  blockedTerrainTypes?: readonly string[]
}

/** Ordered movement facts, independent of damage, costs and coordinate writes. */
export function traceMovementPath(state: SpatialBattleState, origin: GridPosition, direction: GridPosition, options: MovementTraceOptions) {
  if (!Number.isSafeInteger(options.maxDistance) || options.maxDistance < 0
    || !['walkable', 'projectile', 'any'].includes(options.terrain ?? 'walkable')
    || !Number.isInteger(direction.x) || !Number.isInteger(direction.y)
    || Math.abs(direction.x) + Math.abs(direction.y) !== 1 || !isInsideBounds(origin, state.map)) {
    throw new RangeError('Movement trace requires a bounded cardinal path')
  }
  const cells: GridPosition[] = []
  const encounters: Array<{ type: 'piece' | 'terrain' | 'boundary'; x: number; y: number; pieceId?: string }> = []
  let lastLandableCell: GridPosition = { ...origin }
  let blocked = false
  const mover = state.pieces.find(p => p.instanceId === options.excludePieceId)
  for (let step = 1; step <= Math.min(options.maxDistance, state.map.width + state.map.height); step++) {
    const cell = { x: origin.x + direction.x * step, y: origin.y + direction.y * step }
    const tile = state.map.tiles.find(t => t.x === cell.x && t.y === cell.y)
    if (!isInsideBounds(cell, state.map) || !tile) {
      encounters.push({ type: 'boundary', ...cell }); blocked = true; break
    }
    const terrainBlocked = options.terrain === 'any' ? false
      : options.terrain === 'projectile' ? isProjectileTerrainBlocked(tile) : !tile.props?.walkable
    if (terrainBlocked
      || options.blockedTerrainTypes?.includes(tile.props?.type ?? '')) {
      encounters.push({ type: 'terrain', ...cell }); blocked = true; break
    }
    const occupant = getLivingOccupantAt(state.pieces, cell, options.excludePieceId)
    if (occupant) {
      encounters.push({ type: 'piece', ...cell, pieceId: occupant.instanceId })
      const allied = areMatchAllies({ players: state.players ?? [] }, mover?.ownerPlayerId ?? '', occupant.ownerPlayerId ?? '')
      if (!(allied ? options.passAllies : options.passEnemies)) { blocked = true; break }
    }
    cells.push(cell)
    if (!occupant && isLegalSkillLanding(state, cell, { movingPieceIds: options.excludePieceId ? [options.excludePieceId] : [] })) lastLandableCell = cell
  }
  return { cells, encounters, lastLandableCell, blocked, reachedTarget: cells.length === options.maxDistance }
}
