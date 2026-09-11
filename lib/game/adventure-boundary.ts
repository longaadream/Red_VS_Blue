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
  trackingTargetId?: string
  action: BattleAction
}
export interface AdventureBoundary {
  version: 'same-map-v1'
  humanId: string
  completedRoundOffset?: number
  enemyLevels?: Record<string, { level: number; baseMaxHp: number }>
  coop?: {
    humanIds: string[]
    enemyId: string
    round: number
    order: string[]
    parties: Record<string, NonNullable<AdventureBoundary['party']>>
    encounters: Record<string, AdventureZone & { name: string; enemyIds: string[]; coreIds: string[]; reward: number; participants: string[]; round: number; plans: AdventureEnemyPlan[]; plannedRound?:number; kind?: 'roaming'; scaledPlayers: number }>
    playerZones: Record<string, string>
    protectedUntil: Record<string, number>
    absent: string[]
    controllers?:Record<string,string>
  }
  activeZone?: AdventureZone
  activeEnemyIds: string[]
  campaignHasNext?: boolean
  roamingEnemyIds?: string[]
  roamingEncounter?: AdventureZone & { name: string; enemyIds: string[]; coreIds: string[]; reward: number; kind: 'roaming' }
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
  if (world?.coop) {
    selectAdventureActor(state, state.turn.currentPlayerId)
    const player = state.players.find(p => p.playerId === state.turn.currentPlayerId)!
    const zone = world.coop.encounters[world.coop.playerZones[player.playerId]]
    player.maxActionPoints = world.coop.humanIds.includes(player.playerId) ? zone ? Math.min(10, zone.round) : 3 : 0
    player.actionPoints = player.maxActionPoints
    return true
  }
  if (!party || !world) return false
  if (world.activeZone && state.turn.currentPlayerId === world.humanId) party.battleRound++
  const player = state.players.find(p => p.playerId === state.turn.currentPlayerId)!
  player.maxActionPoints = player.playerId !== world.humanId ? 0 : world.activeZone ? Math.min(10, Math.max(1, party.battleRound)) : 3
  player.actionPoints = player.maxActionPoints
  return true
}
export function isAdventureHuman(state: BattleState, playerId: string): boolean {
  const world = adventureBoundary(state)
  return !!world && (world.coop ? world.coop.humanIds.includes(playerId) : world.humanId === playerId)
}
/** Legacy fields are a transient view used by native skill/deployment code. */
export function selectAdventureActor(state: BattleState, playerId: string, encounterId?: string): void {
  const world = adventureBoundary(state), coop = world?.coop
  if (!world || !coop) return
  if (world.party && coop.humanIds.includes(world.humanId)) coop.parties[world.humanId] = world.party
  const human = coop.humanIds.includes(playerId) ? playerId : coop.encounters[encounterId ?? '']?.participants[0] ?? world.humanId
  world.humanId = human; world.party = coop.parties[human]
  const zone = coop.encounters[encounterId ?? coop.playerZones[human]]
  world.activeZone = zone
  world.activeEnemyIds = zone ? zone.enemyIds : (world.roamingEnemyIds ?? []).filter(id => !Object.values(coop.encounters).some(e => e.enemyIds.includes(id)))
  world.plans = zone?.plans ?? []
  world.roamingEncounter = zone?.kind === 'roaming' ? { ...zone, kind: 'roaming' } : undefined
  if (world.party) world.party.battleRound = zone?.round ?? 0
}
/** Only the exact published enemy move is exempt from the player AP economy. */
export function isAdventureProgramMove(state: BattleState, action: BattleAction): boolean {
  const w=adventureBoundary(state),plan=w?.plans?.[0]
  if(!w||!plan||plan.kind!=='move'||action.type!=='move'||plan.action.type!=='move')return false
  const p=state.pieces.find(p=>p.instanceId===action.pieceId&&p.currentHp>0)
  return !!p && p.ownerPlayerId!==w.humanId && p.ownerPlayerId===action.playerId && w.activeEnemyIds.includes(p.instanceId)
    && plan.sourceId===p.instanceId && plan.round===(w.party?.battleRound??1) && p.x===plan.origin.x && p.y===plan.origin.y
    && plan.action.toX===action.toX && plan.action.toY===action.toY
    && (w.activeZone ? insideZone(w.activeZone,action.toX,action.toY) : !!w.roamingEnemyIds?.includes(p.instanceId))
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
  if (world.coop) {
    if(world.coop.absent.includes(piece.ownerPlayerId))return false
    if (!isAdventureHuman(state, piece.ownerPlayerId)) return Object.values(world.coop.encounters).some(e => e.enemyIds.includes(piece.instanceId)) || !!world.roamingEnemyIds?.includes(piece.instanceId)
    const zone = world.coop.encounters[world.coop.playerZones[piece.ownerPlayerId]]
    return !zone || insideZone(zone, piece.x, piece.y)
  }
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
  if (world.coop) {
    const zone = isAdventureHuman(state, piece.ownerPlayerId)
      ? world.coop.encounters[world.coop.playerZones[piece.ownerPlayerId]]
      : Object.values(world.coop.encounters).find(e => e.enemyIds.includes(piece.instanceId))
    if (!zone) {
      if (!isAdventureHuman(state, piece.ownerPlayerId) && !world.roamingEnemyIds?.includes(piece.instanceId) && (x !== piece.x || y !== piece.y)) throw new BattleRuleError('尚未激活的据点不能移动')
      return
    }
    if (insideZone(zone, piece.x, piece.y) && !insideZone(zone,x,y)) throw new BattleRuleError('战区已封锁，战斗结算前无法离开')
    if (!insideZone(zone,piece.x,piece.y) && (x !== piece.x || y !== piece.y)) {
      const distances = supportDistances(state,zone)
      if ((distances.get(`${x},${y}`) ?? Infinity) >= (distances.get(`${piece.x},${piece.y}`) ?? Infinity)) throw new BattleRuleError('区域外棋子只能支援')
    }
    return
  }
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
  if (world.coop) { assertCooperativeTransition(before, after, action); return }
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
function assertCooperativeTransition(before: BattleState, after: BattleState, action?: BattleAction): void {
  const world = adventureBoundary(before)!, coop = world.coop!
  const actor = action && 'playerId' in action ? action.playerId : before.turn.currentPlayerId
  const source = action && 'pieceId' in action ? before.pieces.find(p => p.instanceId === action.pieceId) : undefined
  const zoneFor = (piece: PieceInstance) => coop.encounters[coop.playerZones[piece.ownerPlayerId]] ?? Object.values(coop.encounters).find(e => e.enemyIds.includes(piece.instanceId))
  const zone = source ? zoneFor(source) : coop.encounters[coop.playerZones[actor ?? '']]
  const remains = [...after.pieces,...after.graveyard,...(after.extensions?.removedPieces ?? [])]
  for (const piece of before.pieces) {
    const next = remains.find(p => p.instanceId === piece.instanceId)
    if (next?.x != null && next.y != null) assertAdventurePosition(before,piece,next.x,next.y)
    if(action?.type==='beginPhase'||action?.type==='endTurn')continue
    const pieceZone = zoneFor(piece)
    const untouched = zone ? !insideZone(zone,piece.x,piece.y) : !!pieceZone || !isAdventureHuman(before,piece.ownerPlayerId) && !world.roamingEnemyIds?.includes(piece.instanceId)
    if (untouched && (!next || next.currentHp !== piece.currentHp || next.shield !== piece.shield)) throw new BattleRuleError('禁止跨战区伤害或治疗')
    if (untouched && next) {
      const effects = (p: PieceInstance) => [p.maxHp,p.attack,p.defense,p.moveRange,p.statusTags,p.buffs,p.debuffs,p.ruleTags,p.skills]
      if (JSON.stringify(effects(piece)) !== JSON.stringify(effects(next))) throw new BattleRuleError('禁止跨战区施加效果')
    }
  }
  if (zone) for (const piece of after.pieces) if (!before.pieces.some(p => p.instanceId === piece.instanceId) && !insideZone(zone,piece.x,piece.y)) throw new BattleRuleError('不能在战区外召唤棋子')
}
