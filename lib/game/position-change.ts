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
  flightId?: string
  path?: Omit<MovementTraceOptions, 'excludePieceId' | 'maxDistance'>
  /** Engine-only action boundary: AP/log commit precedes contact. */
  deferContacts?: boolean
  /** Host-only fee commit, never exposed through the author facade. No trigger dispatch. */
  commitAction?: () => void
}
export type PositionChangeResult = { success: true; changes: PositionChangeFact[] }
  | { success: false; changes: []; message: string }
function cancel(message: string): PositionChangeResult { return { success: false, changes: [], message } }

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
    const reason = getPositionChangeRejection(piece, kind)
    if (reason) return cancel(reason)
    const key = `${entry.to.x},${entry.to.y}`
    if (!Number.isSafeInteger(entry.to.x) || !Number.isSafeInteger(entry.to.y) || cells.has(key)
      || !isLegalSkillLanding(battle, entry.to, { movingPieceIds: ids, reservedCells: options.reservedCells, flightId: options.flightId })) return cancel('位移落点被阻挡或已失效')
    cells.add(key)
    if (entry.from.x === entry.to.x && entry.from.y === entry.to.y) continue
    if (kind === 'walk') {
      const rejection = getNormalMoveRejection(battle, piece, entry.to)
      if (rejection) return cancel(rejection.message)
    }
    if (kind === 'walk' || kind === 'dash' || options.path) {
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
