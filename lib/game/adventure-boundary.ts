import type { BattleAction, BattleState } from './turn'
import type { PieceInstance } from './piece'
import type { SkillDefinition } from './skills'
import { BattleRuleError } from './battle-types'
import { getEmptyWalkableDeploymentPositions } from './deployment'

export interface AdventureZone { id: string; x: number; y: number; width: number; height: number }
export interface AdventureEnemyPlan {
  id: string
  sourceId: string
  round: number
  kind: 'move' | 'attack' | 'summon'
  origin: {x:number;y:number}
  cells: {x:number;y:number}[]
  action: BattleAction
}
export interface AdventureBoundary {
  version: 'same-map-v1'
  humanId: string
  activeZone?: AdventureZone
  activeEnemyIds: string[]
  plans?: AdventureEnemyPlan[]
  plansTurn?: number
  skillDefinitions?: Record<string, SkillDefinition>
  party?: {
    captainId: string
    reserves: PieceInstance[]
    anchor: { x: number; y: number }
    battleRound: number
    deploymentRevision: number
    deployedTurn?: number
  }
}
export function adventureDeploymentCells(state: BattleState): { x: number; y: number }[] {
  const world = adventureBoundary(state), party = world?.party
  if (!party || !world?.activeZone || state.terminalResult || state.turn.currentPlayerId !== world.humanId
    || state.turn.phase !== 'action' || state.pendingOptionSelection || state.pendingTargetSelection
    || party.deployedTurn === state.turn.turnNumber || !party.reserves.some(p => p.currentHp > 0)) return []
  const captain = state.pieces.find(p => p.instanceId === party.captainId && p.currentHp > 0)
  const anchor = captain && captain.x !== null && captain.y !== null ? captain : party.anchor
  return getEmptyWalkableDeploymentPositions(state).filter(cell => insideZone(world.activeZone!, cell.x, cell.y)
    && Math.abs(cell.x - anchor.x!) <= 1 && Math.abs(cell.y - anchor.y!) <= 1)
}
/** Called by the native turn transition, including AI simulations. */
export function refreshAdventureActionPoints(state: BattleState): boolean {
  const world = adventureBoundary(state), party = world?.party
  if (!party || !world) return false
  if (world.activeZone && state.turn.currentPlayerId === world.humanId) party.battleRound++
  const player = state.players.find(p => p.playerId === state.turn.currentPlayerId)!
  player.maxActionPoints = player.playerId !== world.humanId ? 0 : world.activeZone ? Math.min(10, Math.max(1, party.battleRound)) : 3
  player.actionPoints = player.maxActionPoints
  return true
}
/** Only the exact published enemy move is exempt from the player AP economy. */
export function isAdventureProgramMove(state: BattleState, action: BattleAction): boolean {
  const w=adventureBoundary(state),plan=w?.plans?.[0]
  if(!w?.activeZone||!plan||plan.kind!=='move'||action.type!=='move'||plan.action.type!=='move')return false
  const p=state.pieces.find(p=>p.instanceId===action.pieceId&&p.currentHp>0)
  return !!p && p.ownerPlayerId!==w.humanId && p.ownerPlayerId===action.playerId && w.activeEnemyIds.includes(p.instanceId)
    && plan.sourceId===p.instanceId && plan.round===(w.party?.battleRound??1) && p.x===plan.origin.x && p.y===plan.origin.y
    && plan.action.toX===action.toX && plan.action.toY===action.toY && insideZone(w.activeZone,action.toX,action.toY)
}
export function updateAdventureCaptainAnchor(state: BattleState): void {
  const party = adventureBoundary(state)?.party
  if (!party) return
  const captain = [...state.pieces, ...state.graveyard, ...(state.extensions?.removedPieces ?? [])]
    .find(p => p.instanceId === party.captainId)
  if (captain && captain.x !== null && captain.y !== null) party.anchor = { x: captain.x, y: captain.y }
}
export function adventureBoundary(state: BattleState): AdventureBoundary | undefined {
  const value = state.extensions?.adventureWorld
  return value?.version === 'same-map-v1' ? value as AdventureBoundary : undefined
}
export function insideZone(zone: AdventureZone, x: number | null, y: number | null): boolean {
  return x !== null && y !== null && x >= zone.x && y >= zone.y && x < zone.x + zone.width && y < zone.y + zone.height
}
export function adventureRuleSourceAllowed(state: BattleState, piece: PieceInstance): boolean {
  const world = adventureBoundary(state)
  if (!world) return true
  if (piece.ownerPlayerId !== world.humanId) return world.activeEnemyIds.includes(piece.instanceId)
  return !world.activeZone || insideZone(world.activeZone, piece.x, piece.y)
}
export function supportDistances(state: BattleState, zone: AdventureZone): Map<string, number> {
  const walkable = new Set(state.map.tiles.filter(t => t.props.walkable).map(t => `${t.x},${t.y}`))
  const distances = new Map<string, number>(), queue: { x: number; y: number }[] = []
  for (const tile of state.map.tiles) if (tile.props.walkable && insideZone(zone, tile.x, tile.y)) {
    distances.set(`${tile.x},${tile.y}`, 0); queue.push(tile)
  }
  for (let index = 0; index < queue.length; index++) {
    const cell = queue[index], distance = distances.get(`${cell.x},${cell.y}`)!
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const next = { x: cell.x+dx, y: cell.y+dy }, key = `${next.x},${next.y}`
      if (walkable.has(key) && !distances.has(key)) { distances.set(key,distance+1); queue.push(next) }
    }
  }
  return distances
}
export function assertAdventurePosition(state: BattleState, piece: PieceInstance, x: number, y: number): void {
  const world = adventureBoundary(state)
  if (!world || piece.x === null || piece.y === null) return
  if (piece.ownerPlayerId !== world.humanId && !world.activeEnemyIds.includes(piece.instanceId)) {
    if (x !== piece.x || y !== piece.y) throw new BattleRuleError('尚未激活的据点不能移动')
    return
  }
  const zone = world.activeZone
  if (!zone) return
  if (insideZone(zone, piece.x, piece.y)) {
    if (!insideZone(zone, x, y)) throw new BattleRuleError('战区已封锁，战斗结算前无法离开')
  } else if (x !== piece.x || y !== piece.y) {
    const distances = supportDistances(state, zone)
    if ((distances.get(`${x},${y}`) ?? Infinity) >= (distances.get(`${piece.x},${piece.y}`) ?? Infinity)) {
      throw new BattleRuleError('队伍已参战，区域外棋子只能沿可通行路径支援')
    }
  }
}
/** Also covers legacy skill scripts that assign coordinates directly. Runs before authority commits. */
export function assertAdventureTransition(before: BattleState, after: BattleState, action?: BattleAction): void {
  const world = adventureBoundary(before)
  if (!world) return
  const allAfter = [...after.pieces, ...after.graveyard, ...(after.extensions?.removedPieces ?? [])] as PieceInstance[]
  for (const piece of before.pieces) {
    const next = allAfter.find(item => item.instanceId === piece.instanceId)
    if (next && next.x !== null && next.y !== null) assertAdventurePosition(before, piece, next.x, next.y)
    const protectedEnemy = piece.ownerPlayerId !== world.humanId && !world.activeEnemyIds.includes(piece.instanceId)
    const outsideAlly = piece.ownerPlayerId === world.humanId && world.activeZone && !insideZone(world.activeZone, piece.x, piece.y)
    if ((protectedEnemy || outsideAlly) && (!next || next.currentHp !== piece.currentHp || next.shield !== piece.shield)) {
      throw new BattleRuleError('封锁边界禁止跨区域伤害或治疗，请先进入战区')
    }
    if ((protectedEnemy || outsideAlly) && next && action?.type !== 'beginPhase' && action?.type !== 'endTurn') {
      const effects = (p: PieceInstance) => [p.maxHp,p.attack,p.defense,p.moveRange,p.statusTags,p.buffs,p.debuffs,p.ruleTags,p.skills]
      if (JSON.stringify(effects(piece)) !== JSON.stringify(effects(next))) throw new BattleRuleError('封锁边界禁止跨区域施加效果，请先进入战区')
    }
  }
  if (world.activeZone) for (const piece of after.pieces) {
    if (!before.pieces.some(item => item.instanceId === piece.instanceId) && !insideZone(world.activeZone, piece.x, piece.y)) {
      throw new BattleRuleError('不能在封锁战区外召唤棋子')
    }
  }
}
