import { assertAdventurePosition } from './adventure-boundary'
import { assertAuthorizedPositions, writePiecePosition } from './position-write-guard'
import type { BattleState } from './turn'
import { BattleRuleError } from './battle-types'
import { globalTriggerSystem, type TriggerContext } from './triggers'
import { getRuleExecutionTriggerSystem } from './rule-runtime'
import { getNormalMoveRejection, getPositionChangeRejection, isLegalSkillLanding, traceMovementPath,
  type GridPosition, type MovementTraceOptions, type PositionChangeKind } from './spatial'
import { submitPositionContacts } from './tile-contact'

export interface PiecePositionChange { pieceId: string; x: number; y: number }
export interface PositionChangeFact {
  pieceId: string; from: GridPosition; to: GridPosition; path: GridPosition[]; kind: PositionChangeKind
}
export interface PositionChangeOptions {
  reservedCells?: readonly GridPosition[]
  path?: Omit<MovementTraceOptions, 'excludePieceId' | 'maxDistance'>
  /** Engine-only action boundary: AP/log commit precedes contact. */
  deferContacts?: boolean
  /** Host-only fee commit, never exposed through the author facade. No trigger dispatch. */
  commitAction?: () => void
}
export type PositionChangeResult = { success: true; changes: PositionChangeFact[] }
  | { success: false; changes: []; message: string }
function cancel(message: string): PositionChangeResult { return { success: false, changes: [], message } }

/**
 * Engine-only landing discovery for a single candidate that is already at
 * zero HP but has not entered the death batch graveyard yet.  Ordinary skill
 * and movement callers must continue to use isLegalSkillLanding directly;
 * this helper is intentionally only consumed by the closed death-parasitism
 * capability.
 */
export function getLegalDyingTeleportCells(
  battle: BattleState,
  dyingPiece: import('./piece').PieceInstance,
  host: import('./piece').PieceInstance,
): GridPosition[] {
  if (!battle.pieces.includes(dyingPiece) || dyingPiece.currentHp !== 0
    || !battle.pieces.includes(host) || host.currentHp <= 0
    || dyingPiece.x == null || dyingPiece.y == null
    || host.x == null || host.y == null) return []
  if (getPositionChangeRejection(dyingPiece, 'teleport')) return []
  const candidates = [
    { x: host.x + 1, y: host.y },
    { x: host.x - 1, y: host.y },
    { x: host.x, y: host.y + 1 },
    { x: host.x, y: host.y - 1 },
  ]
  return candidates.filter(position => isLegalSkillLanding(battle, position))
}

/**
 * Engine-only teleport used by death-time content.  It accepts exactly one
 * canonical HP-zero piece and never appears in the flow facade or browser
 * entry.  The normal position writer and pre-position reactions still guard
 * the commit; a blocked reaction is a normal cancellation.
 */
export function changeDyingPiecePosition(
  battle: BattleState,
  dyingPiece: import('./piece').PieceInstance,
  destination: GridPosition,
  options: { beforeCommit?: (finalDestination: GridPosition) => boolean } = {},
): PositionChangeResult {
  assertAuthorizedPositions(battle)
  if (!battle.pieces.includes(dyingPiece) || dyingPiece.currentHp !== 0
    || dyingPiece.x == null || dyingPiece.y == null) return cancel('濒死棋子已失效')
  if (!Number.isSafeInteger(destination.x) || !Number.isSafeInteger(destination.y)) {
    throw new BattleRuleError('濒死位移落点必须是整数')
  }
  const from = { x: dyingPiece.x, y: dyingPiece.y }
  assertAdventurePosition(battle, dyingPiece, destination.x, destination.y)
  const rejection = getPositionChangeRejection(dyingPiece, 'teleport')
  if (rejection) return cancel(rejection)

  const context: TriggerContext = {
    type: 'beforePiecePositionChange',
    sourcePiece: dyingPiece,
    playerId: dyingPiece.ownerPlayerId,
    movementKind: 'teleport',
    fromX: from.x,
    fromY: from.y,
    targetX: destination.x,
    targetY: destination.y,
    reservedCells: [{ ...destination }],
  }
  const result = getRuleExecutionTriggerSystem(globalTriggerSystem).checkTriggers(battle, context)
  if (result.needsOptionSelection || result.needsTargetSelection) return cancel('濒死位移反应已取消')
  if (result.blocked) return cancel(result.messages.join('；') || '位移被阻止')
  if (!battle.pieces.includes(dyingPiece) || dyingPiece.currentHp !== 0
    || dyingPiece.x !== from.x || dyingPiece.y !== from.y) return cancel('濒死位移起点已失效')
  const finalDestination = { x: context.targetX!, y: context.targetY! }
  if (!Number.isSafeInteger(finalDestination.x) || !Number.isSafeInteger(finalDestination.y)) {
    throw new BattleRuleError('濒死位移反应产生了无效落点')
  }
  assertAdventurePosition(battle, dyingPiece, finalDestination.x, finalDestination.y)
  if (!isLegalSkillLanding(battle, finalDestination)) return cancel('濒死位移落点被阻挡或已失效')
  if (options.beforeCommit && !options.beforeCommit(finalDestination)) return cancel('濒死位移提交条件已失效')

  const change: PositionChangeFact = {
    pieceId: dyingPiece.instanceId,
    from,
    to: finalDestination,
    path: [finalDestination],
    kind: 'teleport',
  }
  writePiecePosition(dyingPiece, finalDestination.x, finalDestination.y)
  battle.actions ??= []
  battle.actions.push({
    type: 'positionChanged',
    playerId: dyingPiece.ownerPlayerId,
    turn: battle.turn.turnNumber,
    payload: {
      pieceId: dyingPiece.instanceId,
      fromX: from.x,
      fromY: from.y,
      toX: finalDestination.x,
      toY: finalDestination.y,
      movementKind: 'teleport',
      path: [finalDestination],
    },
  })
  submitPositionContacts(battle, [change])
  return { success: true, changes: [change] }
}

/** Single coordinate writer. A blocked landing is a normal cancellation. */
export function changePiecePositions(battle: BattleState, changes: readonly PiecePositionChange[], kind: PositionChangeKind,
  options: PositionChangeOptions = {}): PositionChangeResult {
  assertAuthorizedPositions(battle)
  if ((kind === 'teleport' || kind === 'swap') && options.path) throw new BattleRuleError('Teleport and swap have destination contact only')
  if (!['walk','dash','teleport','push','pull','swap'].includes(kind) || changes.length > battle.pieces.length) {
    throw new BattleRuleError('Invalid position-change request')
  }
  const ids = changes.map(change => change.pieceId)
  if (new Set(ids).size !== ids.length || changes.some(c => !Number.isSafeInteger(c.x) || !Number.isSafeInteger(c.y))) {
    throw new BattleRuleError('Position change requires unique pieces and integer coordinates')
  }
  const before = ids.map(id => battle.pieces.find(p => p.instanceId === id))
  if (before.some(p => !p || p.currentHp <= 0 || p.x == null || p.y == null)) return cancel('位移棋子已失效')
  // Freeze every origin before ANY trigger runs, including later members.
  const prepared: PositionChangeFact[] = changes.map((c, i) => ({ pieceId: c.pieceId,
    from: { x: before[i]!.x!, y: before[i]!.y! }, to: { x: c.x, y: c.y }, kind, path: [] }))
  for (const entry of prepared) {
    const piece = before.find(p => p!.instanceId === entry.pieceId)!
    if (!battle.pieces.includes(piece) || piece.currentHp <= 0) return cancel('位移棋子已失效')
    assertAdventurePosition(battle, piece, entry.to.x, entry.to.y)
    const rejection = getPositionChangeRejection(piece, kind)
    if (rejection) return cancel(rejection)
    const context: TriggerContext = { type: 'beforePiecePositionChange', sourcePiece: piece, playerId: piece.ownerPlayerId,
      movementKind: kind, fromX: entry.from.x, fromY: entry.from.y, targetX: entry.to.x, targetY: entry.to.y,
      reservedCells: changes.map(c => ({ x: c.x, y: c.y })) }
    const result = getRuleExecutionTriggerSystem(globalTriggerSystem).checkTriggers(battle, context)
    if (result.needsOptionSelection || result.needsTargetSelection) throw new BattleRuleError('Interactive position-before trigger requires an action continuation')
    if (result.blocked) return cancel(result.messages.join('；') || '位移被阻止')
    entry.to = { x: context.targetX!, y: context.targetY! }
  }
  const cells = new Set<string>()
  for (const entry of prepared) {
    const piece = battle.pieces.find(p => p.instanceId === entry.pieceId)
    if (!piece || !before.includes(piece) || piece.currentHp <= 0 || piece.x !== entry.from.x || piece.y !== entry.from.y) return cancel('前置反应使位移起点失效')
    assertAdventurePosition(battle, piece, entry.to.x, entry.to.y)
    const reason = getPositionChangeRejection(piece, kind)
    if (reason) return cancel(reason)
    const key = `${entry.to.x},${entry.to.y}`
    if (!Number.isSafeInteger(entry.to.x) || !Number.isSafeInteger(entry.to.y) || cells.has(key)
      || !isLegalSkillLanding(battle, entry.to, { movingPieceIds: ids, reservedCells: options.reservedCells })) return cancel('位移落点被阻挡或已失效')
    cells.add(key)
    if (entry.from.x === entry.to.x && entry.from.y === entry.to.y) continue
    if (kind === 'walk') {
      const rejection = getNormalMoveRejection(battle, piece, entry.to)
      if (rejection) return cancel(rejection.message)
    }
    if (kind !== 'teleport' && kind !== 'swap') {
      const dx = entry.to.x - entry.from.x, dy = entry.to.y - entry.from.y
      if (dx !== 0 && dy !== 0) return cancel('位移路径必须沿同一行或同一列')
      const trace = traceMovementPath(battle, entry.from, { x: Math.sign(dx), y: Math.sign(dy) }, {
        ...options.path, excludePieceId: piece.instanceId, maxDistance: Math.abs(dx) + Math.abs(dy),
      })
      if (!trace.reachedTarget) return cancel('位移路径被阻挡')
      entry.path = trace.cells
    } else entry.path = [{ ...entry.to }]
  }
  const actual = prepared.filter(p => p.from.x !== p.to.x || p.from.y !== p.to.y)
  if (kind === 'walk' && actual.length !== prepared.length) return cancel('走格必须改变位置')
  options.commitAction?.()
  for (const entry of actual) {
    const piece = battle.pieces.find(p => p.instanceId === entry.pieceId)!
    writePiecePosition(piece, entry.to.x, entry.to.y)
    battle.actions ??= []
    battle.actions.push({ type: 'positionChanged', playerId: piece.ownerPlayerId, turn: battle.turn.turnNumber,
      payload: { pieceId: piece.instanceId, fromX: entry.from.x, fromY: entry.from.y, toX: entry.to.x, toY: entry.to.y,
        movementKind: kind, path: entry.path.map(c => ({ ...c })) } })
  }
  if (!options.deferContacts) submitPositionContacts(battle, actual)
  return { success: true, changes: actual }
}

/** Compatibility guard while trusted author surfaces are migrated. */
export function assertRestrictedPositionsUnchanged(before: BattleState, after: BattleState): void {
  for (const piece of before.pieces) {
    if (!getPositionChangeRejection(piece, 'teleport')) continue
    const current = after.pieces.find(candidate => candidate.instanceId === piece.instanceId && candidate.currentHp > 0)
    if (current && current.x != null && current.y != null && piece.x != null && piece.y != null
      && (current.x !== piece.x || current.y !== piece.y)) throw new BattleRuleError('An imprisoned piece cannot change its board position')
  }
}
