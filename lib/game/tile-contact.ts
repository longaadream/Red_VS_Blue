import type { BattleState } from './turn'
import type { PositionChangeFact } from './position-change'
import { collectChargeCrystalsAt } from './charge-crystals'
import { globalTriggerSystem, type TriggerContext } from './triggers'
import { getRuleExecutionTriggerSystem } from './rule-runtime'

type Receipt = ReturnType<typeof collectPositionContacts>[number]
type ContactScope = { ids: Set<string>; receipts: Receipt[]; previous?: ContactScope }
const deferred = new WeakMap<BattleState, ContactScope>()

/** Host-bound compound effects (clone/recall) settle their own contacts after required effects. */
export function beginCompoundPositionContacts(battle: BattleState, ids: string[]) {
  const previous = deferred.get(battle)
  const scope: ContactScope = { ids: new Set(ids), receipts: [], previous }
  deferred.set(battle, scope)
  const restore = () => { if (previous) deferred.set(battle, previous); else deferred.delete(battle) }
  return {
    flush: () => { restore(); submitReceipts(battle, scope.receipts.splice(0)) },
    cleanup: restore,
  }
}

export function submitPositionContacts(battle: BattleState, changes: PositionChangeFact[]): void {
  submitReceipts(battle, collectPositionContacts(battle, changes))
}

function submitReceipts(battle: BattleState, receipts: Receipt[]): void {
  let owner: ContactScope | undefined
  for (let scope = deferred.get(battle); scope; scope = scope.previous) {
    if (receipts.some(r => scope.ids.has(r.change.pieceId))) owner = scope
  }
  // Preserve the complete group until every enclosing compound effect is ready.
  if (owner) { owner.receipts.push(...receipts); return }
  dispatchReceipts(battle, receipts)
}

function dispatchPositionContact(battle: BattleState, context: TriggerContext): void {
  const result = getRuleExecutionTriggerSystem(globalTriggerSystem).checkTriggers(battle, context)
  if (result.needsTargetSelection || result.needsOptionSelection) throw new Error('Tile contact interaction requires an action continuation')
  for (const message of result.messages ?? []) {
    battle.actions ??= []
    battle.actions.push({ type: 'triggerEffect', playerId: context.playerId!, turn: battle.turn.turnNumber, payload: { message } })
  }
}

/** All positions commit before collection; all collection commits before reactions. */
export function settlePositionContacts(battle: BattleState, changes: readonly PositionChangeFact[]): void {
  dispatchReceipts(battle, collectPositionContacts(battle, changes))
}

function collectPositionContacts(battle: BattleState, changes: readonly PositionChangeFact[]) {
  const ordered = [...changes].sort((a,b) => a.pieceId < b.pieceId ? -1 : a.pieceId > b.pieceId ? 1 : 0)
  return ordered.flatMap(change => {
    const piece = battle.pieces.find(p => p.instanceId === change.pieceId && p.currentHp > 0)
    if (!piece || piece.x !== change.to.x || piece.y !== change.to.y) return []
    const player = battle.players.find(p => p.playerId === piece.ownerPlayerId)
    if (!player) throw new Error('Position contact collector has no owner')
    const seen = new Set<string>()
    const path = change.path.filter(cell => {
      const key = `${cell.x},${cell.y}`
      if (seen.has(key) || cell.x === change.from.x && cell.y === change.from.y) return false
      seen.add(key); return true
    })
    const crystals = path.flatMap(cell => collectChargeCrystalsAt(battle, cell.x, cell.y))
    player.chargePoints += crystals.length
    if (crystals.length) {
      battle.actions ??= []
      battle.actions.push({ type: 'chargeCrystalPickedUp', playerId: player.playerId, turn: battle.turn.turnNumber,
        payload: { message: `${piece.name || piece.templateId}经过地格，拾取${crystals.length}个充能结晶`,
          pieceId: piece.instanceId, crystalIds: crystals.map(c => c.id), amount: crystals.length,
          x: change.to.x, y: change.to.y, cells: crystals.map(c => ({ x: c.x, y: c.y })) } })
    }
    return [{ change, piece, playerId: player.playerId, amount: crystals.length, path }]
  })
}

function dispatchReceipts(battle: BattleState, receipts: Receipt[]): void {
  for (const receipt of receipts) if (receipt.amount) dispatchPositionContact(battle, {
    type: 'afterChargeGained', piece: receipt.piece, sourcePiece: receipt.piece, playerId: receipt.playerId, amount: receipt.amount,
  })
  for (const { change, piece, playerId, path } of receipts) {
    if (!battle.pieces.includes(piece) || piece.currentHp <= 0) continue
    const context = { sourcePiece: piece, playerId, movementKind: change.kind, fromX: change.from.x, fromY: change.from.y,
      targetX: change.to.x, targetY: change.to.y, pathCells: path, contactCells: path }
    dispatchPositionContact(battle, { ...context, type: 'afterPiecePathContact' })
    if (battle.pieces.includes(piece) && piece.currentHp > 0 && piece.x === change.to.x && piece.y === change.to.y) {
      dispatchPositionContact(battle, { ...context, type: 'afterPiecePositionChange' })
    }
  }
}
