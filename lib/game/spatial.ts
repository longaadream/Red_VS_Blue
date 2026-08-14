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
}

export interface SpatialBattleState {
  map: SpatialMap
  pieces: readonly SpatialPiece[]
}

export interface NormalMoveActionState extends SpatialBattleState {
  players: ReadonlyArray<{
    playerId: string
    actionPoints: number
  }>
  turn: {
    currentPlayerId: string
    phase: string
  }
}

export type NormalMoveRejectionCode =
  | 'piece-not-on-board'
  | 'target-outside-board'
  | 'not-orthogonal'
  | 'same-position'
  | 'invalid-move-range'
  | 'out-of-range'
  | 'terrain-blocked'
  | 'piece-blocked'
  | 'target-occupied'

export interface NormalMoveRejection {
  code: NormalMoveRejectionCode
  message: string
  at?: GridPosition
}

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

export function getNormalMoveRejection(
  state: SpatialBattleState,
  piece: SpatialPiece,
  target: GridPosition,
): NormalMoveRejection | null {
  if (piece.x == null || piece.y == null) {
    return { code: 'piece-not-on-board', message: 'Piece is not on the board' }
  }
  if (!isInsideBounds(target, state.map)) {
    return { code: 'target-outside-board', message: 'Target position is outside of the board', at: target }
  }

  const from = { x: piece.x, y: piece.y }
  const line = getOrthogonalLineCells(from, target)
  if (line === null) {
    return { code: 'not-orthogonal', message: 'Move must be in a straight line (rook-style)', at: target }
  }
  if (line.length === 0) {
    return { code: 'same-position', message: 'Move must change the piece position', at: target }
  }

  const maxRange = piece.moveRange
  if (typeof maxRange !== 'number' || !Number.isFinite(maxRange) || maxRange < 0) {
    return { code: 'invalid-move-range', message: 'Piece has an invalid moveRange' }
  }
  if (manhattanDistance(from, target) > Math.floor(maxRange)) {
    return { code: 'out-of-range', message: 'Move distance exceeds piece moveRange', at: target }
  }

  for (let index = 0; index < line.length; index++) {
    const cell = line[index]
    const tile = state.map.tiles.find(candidate => candidate.x === cell.x && candidate.y === cell.y)
    if (!tile?.props?.walkable) {
      return { code: 'terrain-blocked', message: 'Path is blocked by unwalkable terrain', at: cell }
    }

    const occupant = getLivingOccupantAt(state.pieces, cell, piece.instanceId)
    if (occupant) {
      const isTarget = index === line.length - 1
      return {
        code: isTarget ? 'target-occupied' : 'piece-blocked',
        message: isTarget ? 'Target tile is already occupied' : 'Path is blocked by a living piece',
        at: cell,
      }
    }
  }

  return null
}

export function getLegalNormalMoveTargets(
  state: SpatialBattleState,
  piece: SpatialPiece,
): GridPosition[] {
  if (piece.x == null || piece.y == null) return []
  const maxRange = piece.moveRange
  if (typeof maxRange !== 'number' || !Number.isFinite(maxRange) || maxRange <= 0) return []

  const targets: GridPosition[] = []
  for (const direction of ORTHOGONAL_DIRECTIONS) {
    for (let distance = 1; distance <= Math.floor(maxRange); distance++) {
      const target = {
        x: piece.x + direction.x * distance,
        y: piece.y + direction.y * distance,
      }
      if (!isInsideBounds(target, state.map)) break
      if (getNormalMoveRejection(state, piece, target)) break
      targets.push(target)
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
  if (!player || player.actionPoints < 1) return []

  const piece = state.pieces.find(candidate => candidate.instanceId === pieceId
    && candidate.ownerPlayerId?.toLowerCase() === normalizedPlayerId
    && candidate.currentHp > 0)
  return piece ? getLegalNormalMoveTargets(state, piece) : []
}
