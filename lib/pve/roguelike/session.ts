import {adventureCardCounters,forecastAdventureThreats} from './insights'
import { createInitialBattleForPlayers } from '../../game/battle-setup'
import { getPieceById } from '../../game/piece-repository'
import { runBattleActionIsolated, hashBattleState } from '../../game/battle-runner'
import { safeCloneBattleState, type BattleAction, type BattleState } from '../../game/turn'
import { toPublicBattleState } from '../../game/deployment'
import { getCurrentInputOwnerPlayerId } from '../../game/turn-timer'
import { recordBattlePresentation } from '../../game/battle-presentation-recording'
import { projectBattlePresentationEvents, projectBattlePresentationEventsForViewer } from '../../game/battle-presentation-events'
import { insideZone, adventureBoundary, assertAdventurePosition, adventureDeploymentCells } from '../../game/adventure-boundary'
import { getLegalNormalMoveTargetsForPlayer } from '../../game/spatial'
import { planAdventureEnemies, adventurePlanInvalidReason, shortenBlockedAdventureMove } from './plans'
import type { GameProfileIdentityV1 } from '../../content-pipeline/runtime/profile-game-identity'
import { HUMAN, ENEMY, createAdventureMap, adventureContent } from './content'
import type { RoguelikeAdventureV1 } from '../contracts/roguelike-content-v1'
import type { PieceInstance } from '../../game/piece'
import { buildAdventureRecruit, recruitmentOffers } from './recruitment'
import { enemyTemplates, enemySkills, strengthenEliteGuards, completedAdventureRounds, upgradeWaitingEnemies } from './enemies'
import { adventureSupplies } from './content'
import { adventureCards, initializeAdventureCards, hasAdventureCardChoice } from '../../game/adventure-card-state'
import { supplyEncounter, cleanupAdventureCards, offerAdventureRewards, chooseAdventureSupply, withAdventureSupplyRuntime } from './supplies'
import { campaignAct } from './campaign'
import { initializeRoaming, planRoamingEnemies, tryStartRoamingEncounter, getRoamingEncounter } from './roaming'

function adventureTemplates() { return enemyTemplates }

export interface WorldProgress { coins: number; cleared: string[]; claimed: string[]; log: string[]; campVisits: number;
  lastReward?: { id: string; name: string; coins: number; kind: 'encounter' | 'roaming' };
  recruited: PieceInstance[]; dismissals: number; upgrades: Record<string, { attack: number; maxHp: number; defense: number }> }
const allowed = new Set(['move', 'useBasicSkill', 'useChargeSkill', 'playCard', 'endTurn', 'beginPhase',
  'pendingOptionSelect', 'pendingTargetSelect', 'cancelPendingSelection', 'surrender', 'deployReservePiece'])
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export async function createAdventureState(profile: GameProfileIdentityV1, content = adventureContent) {
  const { enemyLineup, startingPositions } = content
  const templates = adventureTemplates()
  const roster = (playerId: string, ids: string[], faction: 'red' | 'blue') => ({ playerId, faction,
    pieces: ids.map(id => { const piece = templates.find(p => p.id === id) ?? getPieceById(id); if (!piece) throw new Error(`缺少冒险角色 ${id}`); return piece }) })
  const state = await createInitialBattleForPlayers([HUMAN, ENEMY], [], [
    roster(HUMAN, content.party.pieceIds, 'red'), roster(ENEMY, enemyLineup.map(p => p.templateId), 'blue'),
  ], undefined, { firstPlayerId: HUMAN, rootSeed: content.party.seed, profileIdentity: profile,
    adventureWorld: { map: createAdventureMap(content), humanId: HUMAN, captainId: `${HUMAN}-1`, positions: startingPositions,
      coreIds:[...content.party.pieceIds.map((_,i)=>`${HUMAN}-${i+1}`),...enemyLineup.filter(p => p.core && !content.zones.find(z=>z.id===p.zone)?.optional).map(p => p.id)], skills:enemySkills } })
  if (!state) throw new Error('无法创建冒险')
  strengthenEliteGuards(state,content)
  if (adventureSupplies) initializeAdventureCards(state, HUMAN, adventureSupplies.initialRelicIds)
  initializeRoaming(state, content)
  return state
}

/** Single owner. Every world command records both formal battle and world transitions.
 * BattleTrace alone is not an adventure replay; persistent restore is deliberately not exposed yet. */
export class AdventureSession {
  private threatCache: ReturnType<typeof forecastAdventureThreats> | undefined
  private insightRevision = -1
  private insightCache = new Map<string, {counters:ReturnType<typeof adventureCardCounters>;forecast:ReturnType<typeof forecastAdventureThreats>}>()
  protected revision = 0
  protected progress: WorldProgress = { coins: 0, cleared: [], claimed: [], log: ['抵达旅人营地。寻找补给与同行者，再向哨站进发。'], campVisits: 0, upgrades: {}, recruited: [], dismissals: 0 }
  protected initial: BattleState
  protected content: RoguelikeAdventureV1
  protected offers: Record<string, string[]>
  protected actIndex = 0
  protected campaign: RoguelikeAdventureV1
  protected playerId = HUMAN
  protected receipts: { revision: number; command: unknown; before: string; after: string; world: WorldProgress }[] = []
  constructor(protected state: BattleState, content = adventureContent, protected profile?: GameProfileIdentityV1) {
    this.state = safeCloneBattleState(state)
    this.content = copy(content); this.offers = recruitmentOffers(this.content)
    this.campaign = copy(content)
    adventureBoundary(this.state)!.campaignHasNext = !!content.nextActs?.length
    this.initial = safeCloneBattleState(this.state)
  }
  get currentRevision() { return this.revision }
  snapshot() {
    if(this.insightRevision!==this.revision){this.insightCache.clear();this.threatCache=undefined;this.insightRevision=this.revision}
    if(!this.insightCache.has(this.playerId))this.insightCache.set(this.playerId,{counters:adventureCardCounters(this.state,this.playerId),forecast:this.threatCache??(this.threatCache=forecastAdventureThreats(this.state))})
    const insights=this.insightCache.get(this.playerId)!
    const { zones, sites, enemyLineup } = this.content
    const state = copy(toPublicBattleState(this.state, this.playerId))
    if (state.extensions) delete state.extensions.debugBattle
    state.skillsById = {}; state.actions = []
    const active = adventureBoundary(this.state)?.activeZone?.id
    const party = adventureBoundary(this.state)?.party
    const legalMoves: Record<string, string[]> = {}
    for (const piece of this.state.pieces.filter(p => p.ownerPlayerId === this.playerId)) {
      legalMoves[piece.instanceId] = getLegalNormalMoveTargetsForPlayer(this.state, this.playerId, piece.instanceId).filter(cell => {
        if (!zones.some(z=>z.optional!==undefined) && !adventureBoundary(this.state)?.coop && zones.some((zone,index) => insideZone(zone,cell.x,cell.y) && zones.slice(0,index).some(prior=>!this.progress.cleared.includes(prior.id)))) return false
        try { assertAdventurePosition(this.state, piece, cell.x, cell.y); return true } catch { return false }
      }).map(cell => `${cell.x},${cell.y}`)
    }
    return { state, legalMoves, content: {templates:adventureTemplates(), skills:enemySkills}, deployment: { pieces: copy(party?.reserves ?? []), cells: adventureDeploymentCells(this.state), revision: party?.deploymentRevision ?? 0,
      used: party?.deployedTurn === this.state.turn.turnNumber }, revision: this.revision, inputOwner: hasAdventureCardChoice(this.state, this.playerId)
        && !this.state.pendingOptionSelection && !this.state.pendingTargetSelection ? this.playerId : getCurrentInputOwnerPlayerId(this.state), humanPlayerId: this.playerId,
      aiPlayerId: ENEMY, world: { ...copy(insights), ...copy(this.progress), active, sites, zones: [...zones, ...(getRoamingEncounter(this.state) ? [getRoamingEncounter(this.state)!] : [])], enemies:enemyLineup, plans:adventureBoundary(this.state)?.plans ?? [], captainId: `${this.playerId}-1`,
        actNumber: this.actIndex + 1, actCount: 1 + (this.campaign.nextActs?.length ?? 0), name: this.content.name,
        actReady: zones.filter(z=>!z.optional).every(zone => this.progress.cleared.includes(zone.id)),
        worldRound: completedAdventureRounds(this.state) + 1, battleRound: party?.battleRound ?? 0, complete: !!this.state.terminalResult,
        supplies: adventureSupplies, cardProgress: copy(adventureCards(this.state) ?? null), seed: this.content.party.seed,
        recruitment: this.content.recruitment ? { ...copy(this.content.recruitment), offers: copy(this.offers),
          dismissPrice: this.content.recruitment.dismissCost * (this.progress.dismissals + 1) } : undefined,
        stage: `第 ${this.actIndex + 1} 幕 · ${this.state.map.width}×${this.state.map.height} · 本页关闭后不保留` } }
  }
  protected check(revision: number) {
    if (revision !== this.revision) throw new Error('指令已过期，请重试')
    if (this.state.terminalResult) throw new Error('本次冒险已结束')
  }
  protected settle(state: BattleState, progress: WorldProgress) {
    const world = adventureBoundary(state)!
    const zone = this.content.zones.find(zone => zone.id === world.activeZone?.id) ?? getRoamingEncounter(state)
    if (!zone || state.pendingOptionSelection || state.pendingTargetSelection) return
    if (state.terminalResult && state.terminalResult.winnerPlayerId !== this.playerId && !state.terminalResult.winnerPlayerIds?.includes(this.playerId)) return
    if (zone.coreIds.some(id => state.pieces.some(piece => piece.instanceId === id && piece.currentHp > 0))) return
    if (!progress.cleared.includes(zone.id)) {
      progress.cleared.push(zone.id)
      if (!getRoamingEncounter(state)) progress.coins += zone.reward
      progress.lastReward = { id: zone.id, name: zone.name, coins: zone.reward, kind: getRoamingEncounter(state) ? 'roaming' : 'encounter' }
      progress.log.unshift(`${zone.name}已清除，获得 ${zone.reward} 枚金币。封锁解除。`)
      // Initial and recruited allies restore their own template; wounds and numeric upgrades persist.
      const party = world.party
      const baselinePieces = [...this.initial.pieces, ...this.initial.graveyard, ...(adventureBoundary(this.initial)?.coop ? Object.values(adventureBoundary(this.initial)!.coop!.parties).flatMap(p=>p.reserves) : adventureBoundary(this.initial)?.party?.reserves ?? []), ...progress.recruited]
      const livingAllies = [...state.pieces, ...(party?.reserves ?? [])].filter(piece => piece.ownerPlayerId === this.playerId && piece.isCore && piece.currentHp > 0)
      const restored = livingAllies.map(piece => {
        const baseline = baselinePieces.find(item => item.instanceId === piece.instanceId)!
        const { x, y, currentHp } = piece
        const upgrades = progress.upgrades[piece.instanceId] ?? { attack: 0, maxHp: 0, defense: 0 }
        const maxHp = baseline.maxHp + upgrades.maxHp
        return { ...copy(baseline), x, y, currentHp: Math.min(currentHp, maxHp), maxHp,
          attack: baseline.attack + upgrades.attack, defense: baseline.defense + upgrades.defense }
      })
      state.pieces = [...state.pieces.filter(p => p.ownerPlayerId !== this.playerId && !world.activeEnemyIds.includes(p.instanceId)), ...restored]
      if (party) {
        let captain = restored.find(p => p.instanceId === party.captainId)
        if (!captain) {
          const baseline = baselinePieces.find(p => p.instanceId === party.captainId)!
          const upgrades = progress.upgrades[party.captainId] ?? { attack: 0, maxHp: 0, defense: 0 }
          captain = { ...copy(baseline), ...party.anchor, currentHp: 1, maxHp: baseline.maxHp + upgrades.maxHp,
            attack: baseline.attack + upgrades.attack, defense: baseline.defense + upgrades.defense }
          state.graveyard = state.graveyard.filter(p => p.instanceId !== party.captainId)
          if (state.extensions?.removedPieces) state.extensions.removedPieces = state.extensions.removedPieces.filter((p: { instanceId: string }) => p.instanceId !== party!.captainId)
          state.pieces.push(captain)
          progress.log.unshift('队长在胜利后复活，恢复到 1 点生命。')
        }
        party.reserves = restored.filter(p => p.instanceId !== party.captainId)
        party.reserves.forEach(p => { p.x = null; p.y = null })
        state.pieces = state.pieces.filter(p => p.ownerPlayerId !== this.playerId || p.instanceId === party.captainId)
        party.battleRound = 0; delete party.deployedTurn
        for (const player of state.players.filter(p => !world.coop || p.playerId === this.playerId)) {
          player.maxActionPoints = player.playerId === this.playerId ? 3 : 0
          player.actionPoints = player.maxActionPoints
        }
      }
      cleanupAdventureCards(state, world.coop ? this.playerId : undefined)
      for (const player of state.players.filter(p => !world.coop || p.playerId === this.playerId)) { player.statusTags = []; player.chargePoints = 0 }
      if (adventureSupplies) offerAdventureRewards(state, this.playerId, zone.id, adventureSupplies, adventureSupplies.rewardRelicLimit === undefined || this.content.zones.some(z=>z.id===zone.id&&z.elite))
      if (state.extensions) delete state.extensions.recallData
      world.plans = []
      delete world.plansTurn
      world.activeZone = undefined; world.activeEnemyIds = []
      delete world.roamingEncounter
      initializeRoaming(state, this.content)
    }
  }
  protected commit(state: BattleState, progress: WorldProgress, command: unknown, action?: BattleAction, events: unknown[] = []) {
    const before = hashBattleState(this.state)
    const upgraded = upgradeWaitingEnemies(state, this.content)
    if (upgraded) progress.log.unshift(`世界回合推进，${upgraded} 个未交战敌人升级。`)
    const roaming = this.content.roaming
    if (roaming) {
      const remains = [...state.pieces, ...state.graveyard, ...(state.extensions?.removedPieces ?? [])]
      for (const id of roaming.enemyIds) {
        const marker = `kill:${id}`
        if (progress.claimed.includes(marker) || !remains.some(piece => piece.instanceId === id && piece.currentHp <= 0)) continue
        progress.claimed.push(marker); progress.coins += roaming.reward
        const name = remains.find(piece => piece.instanceId === id)?.name ?? '巡游怪物'
        progress.lastReward = { id: marker, name, coins: roaming.reward, kind: 'roaming' }
        progress.log.unshift(`击杀${name}，获得 ${roaming.reward} 枚金币。`)
      }
    }
    let world = adventureBoundary(state)!
    if (!hasAdventureCardChoice(state, this.playerId)) {
      const ambush = tryStartRoamingEncounter(state, this.content)
      if (ambush) progress.log.unshift(`遭遇${ambush.name}，清除追击者可获得 ${ambush.reward} 枚金币。`)
    }
    if (world.party && world.activeZone && !adventureBoundary(this.state)?.activeZone) {
      delete world.plansTurn
      world.plans = []
      world.party.battleRound = 1; delete world.party.deployedTurn
      for (const player of state.players) {
        player.maxActionPoints = player.playerId === this.playerId ? 1 : 0
        player.actionPoints = player.playerId === this.playerId ? 1 : 0
      }
      progress.log.unshift('探索行动结束，战斗第 1 轮：1 行动点，每回合可免费部署 1 枚棋子。')
      if (adventureSupplies) withAdventureSupplyRuntime(state, () => supplyEncounter(state, this.playerId, world.activeZone!.id, adventureSupplies!))
      world = adventureBoundary(state)!
    }
    if (action && state.turn.currentPlayerId === ENEMY && world.plans?.[0] && 'pieceId' in action && action.pieceId === world.plans[0].sourceId) world.plans.shift()
    if (world.activeZone) {
      // Native summons belong to this encounter, including those that die within the command.
      for (const p of [...state.pieces, ...state.graveyard]) if (p.ownerPlayerId === ENEMY && insideZone(world.activeZone,p.x,p.y)
        && !this.content.enemyLineup.some(enemy => enemy.id === p.instanceId)
        && !world.activeEnemyIds.includes(p.instanceId)) world.activeEnemyIds.push(p.instanceId)
      if (state.turn.currentPlayerId === this.playerId && state.turn.phase === 'action' && !state.pendingOptionSelection && !state.pendingTargetSelection
        && world.plansTurn !== state.turn.turnNumber) {
        world.plans = planAdventureEnemies(state); world.plansTurn = state.turn.turnNumber
      }
    }
    if (!world.activeZone && state.turn.currentPlayerId === this.playerId && state.turn.phase === 'action'
      && !state.pendingOptionSelection && !state.pendingTargetSelection && world.plansTurn !== state.turn.turnNumber) {
      world.plans = planRoamingEnemies(state, this.content); world.plansTurn = state.turn.turnNumber
    }
    this.settle(state, progress)
    this.state = state; this.progress = progress; this.revision++
    this.progress.log = this.progress.log.slice(0, 20)
    this.receipts.push({ revision: this.revision, command: copy(command), before, after: hashBattleState(state), world: copy(progress) })
    return { ...this.snapshot(), action, events: projectBattlePresentationEventsForViewer(events as Parameters<typeof projectBattlePresentationEventsForViewer>[0], this.playerId) }
  }
  protected apply(action: BattleAction, stage = safeCloneBattleState(this.state), progress = copy(this.progress)) {
    const before = stage
    const result = recordBattlePresentation(before, () => runBattleActionIsolated(before, action, { rootSeed: this.content.party.seed }), r => r.state)
    const events = projectBattlePresentationEvents({
      actionId: `adventure-${this.revision + 1}`, command: action, beforeState: before, afterState: result.state })
    return this.commit(result.state, progress, action, action, events)
  }
  human(action: BattleAction, revision: number) {
    this.check(revision)
    if (!action || !allowed.has(action.type)) throw new Error('冒险不接受管理指令')
    if ('playerId' in action && action.playerId !== undefined && action.playerId !== this.playerId) throw new Error('只能操作自己的队伍')
    if (action.type !== 'surrender' && getCurrentInputOwnerPlayerId(this.state) !== this.playerId) throw new Error('等待敌方行动')
    if (action.type !== 'surrender' && hasAdventureCardChoice(this.state, this.playerId)
      && !this.state.pendingOptionSelection && !this.state.pendingTargetSelection) throw new Error('请先处理补给或溢出的手牌')
    const stage = safeCloneBattleState(this.state), progress = copy(this.progress)
    const world = adventureBoundary(stage)!
    const actor = 'pieceId' in action ? stage.pieces.find(p => p.instanceId === action.pieceId) : undefined
    if (!world.activeZone && ['useBasicSkill', 'useChargeSkill', 'playCard'].includes(action.type)) throw new Error('技能和卡牌仅在正式战斗中使用')
    if (world.activeZone && actor && !insideZone(world.activeZone, actor.x, actor.y) && action.type !== 'move') throw new Error('区域外棋子请先移动进入战区支援')
    if (action.type === 'move' && actor) {
      const { zones } = this.content
      const zone = zones.find(z => !progress.cleared.includes(z.id) && insideZone(z, action.toX, action.toY))
      if (zone && !world.activeZone) {
        if (!zones.some(z=>z.optional!==undefined) && !world.coop && zones.slice(0,zones.indexOf(zone)).some(prior=>!progress.cleared.includes(prior.id))) throw new Error('请先清除前面的据点')
        world.activeZone = copy(zone); world.activeEnemyIds = [...zone.enemyIds]
        progress.log.unshift(`进入${zone.name}：战区封锁。区域外队员只能赶来支援。`)
      }
    }
    return this.apply({ ...action, playerId: this.playerId } as BattleAction, stage, progress)
  }
  interact(siteId: string, operation: string, pieceId: string, revision: number, targetPieceId = pieceId) {
    this.check(revision)
    if (hasAdventureCardChoice(this.state, this.playerId)) throw new Error('请先处理补给或溢出的手牌')
    if (getCurrentInputOwnerPlayerId(this.state) !== this.playerId || this.state.turn.phase !== 'action'
      || this.state.pendingOptionSelection || this.state.pendingTargetSelection) throw new Error('请先完成当前回合选择')
    if (adventureBoundary(this.state)?.activeZone) throw new Error('战区封锁期间不能搜索或使用营地')
    const site = this.content.sites.find(site => site.id === siteId)
    const piece = this.state.pieces.find(p => p.instanceId === pieceId && p.ownerPlayerId === this.playerId && p.currentHp > 0)
    if (!site || !piece || piece.x === null || piece.y === null || Math.abs(piece.x - site.x) + Math.abs(piece.y - site.y) > 1) throw new Error('请选中并移动一名队员到设施相邻格')
    const next = safeCloneBattleState(this.state), progress = copy(this.progress)
    const player = next.players.find(p => p.playerId === this.playerId)!
    if (site.kind === 'recruit') {
      const config = this.content.recruitment
      if (!config || operation !== 'recruit' || !this.offers[site.id]?.includes(targetPieceId)) throw new Error('请选择此处的招募候选')
      if (progress.claimed.includes(site.id)) throw new Error('此处已招募过一名同行者')
      if (progress.coins < config.cost) throw new Error(`招募需要 ${config.cost} 枚金币`)
      const party = adventureBoundary(next)?.party
      if (!party) throw new Error('预备队不可用')
      const recruit = buildAdventureRecruit(next, targetPieceId, `${this.playerId}-recruit-${this.actIndex ? `${this.actIndex}-` : ''}${site.id}`, this.playerId, ENEMY)
      party.reserves.push(recruit); party.deploymentRevision++
      progress.recruited.push(copy(recruit)); progress.coins -= config.cost; progress.claimed.push(site.id)
      progress.log.unshift(`${recruit.name}加入预备队，花费 ${config.cost} 枚金币。`)
      return this.commit(next, progress, { type: 'recruit', siteId, pieceId, templateId: targetPieceId, instanceId: recruit.instanceId })
    }
    if (site.kind === 'loot') {
      if (operation !== 'search' || progress.claimed.includes(site.id)) throw new Error('这里已经搜过了')
      if (player.actionPoints < 1) throw new Error('搜索需要 1 行动点')
      player.actionPoints--; progress.claimed.push(site.id); progress.coins += 15
      progress.log.unshift(`搜索${site.name}，获得 15 枚金币。`)
      return this.commit(next, progress, { type: 'search', siteId, pieceId })
    }
    if (site.kind !== 'camp') throw new Error('进入标记范围即可触发遭遇')
    if (operation === 'dismiss') {
      const party = adventureBoundary(next)?.party, config = this.content.recruitment
      if (!party || !config || targetPieceId === party.captainId) throw new Error('不能移除队长')
      const index = party.reserves.findIndex(p => p.instanceId === targetPieceId)
      if (index < 0) throw new Error('请选择预备队员')
      const cost = config.dismissCost * (progress.dismissals + 1)
      if (progress.coins < cost) throw new Error(`遣散需要 ${cost} 枚金币`)
      const [removed] = party.reserves.splice(index, 1)
      party.deploymentRevision++; progress.coins -= cost; progress.dismissals++
      progress.log.unshift(`${removed.name}离开队伍，花费 ${cost} 枚金币。`)
      return this.commit(next, progress, { type: 'dismiss', siteId, pieceId, targetPieceId })
    } else if (operation === 'heal') {
      for (const ally of [...next.pieces, ...(adventureBoundary(next)?.party?.reserves ?? [])].filter(p => p.ownerPlayerId === this.playerId && p.currentHp > 0)) ally.currentHp = Math.min(ally.maxHp, ally.currentHp + Math.ceil(ally.maxHp * .4))
      progress.log.unshift('全队恢复 40% 最大生命，休整推进一个世界回合。')
    } else if (['attack', 'maxHp', 'defense'].includes(operation)) {
      if (progress.coins < 20) throw new Error('强化需要 20 枚金币')
      const ally = [...next.pieces, ...(adventureBoundary(next)?.party?.reserves ?? [])].find(p => p.instanceId === targetPieceId && p.ownerPlayerId === this.playerId && p.currentHp > 0)
      if (!ally) throw new Error('请选择存活的队员进行强化')
      const upgrades = progress.upgrades[ally.instanceId] ??= { attack: 0, maxHp: 0, defense: 0 }
      upgrades[operation as 'attack' | 'defense' | 'maxHp']++
      if (operation === 'attack') ally.attack++
      if (operation === 'defense') ally.defense++
      if (operation === 'maxHp') { ally.maxHp++; ally.currentHp++ }
      progress.coins -= 20; progress.log.unshift(`${ally.name}完成一次数值强化，花费 20 枚金币。`)
    } else throw new Error('营地操作无效')
    progress.campVisits++
    return this.apply({ type: 'endTurn', playerId: this.playerId }, next, progress)
  }
  step(revision: number) {
    this.check(revision)
    if (hasAdventureCardChoice(this.state, this.playerId)) throw new Error('请先处理补给或溢出的手牌')
    if (getCurrentInputOwnerPlayerId(this.state) !== ENEMY) throw new Error('正在等待玩家')
    if (this.state.turn.phase !== 'action') return this.apply({type:'beginPhase'})
    const world = adventureBoundary(this.state)!, plan = world.plans?.[0]
    if (!plan) return this.apply({type:'endTurn',playerId:ENEMY})
    const cancel = (reason: string) => {
      const stage=safeCloneBattleState(this.state),progress=copy(this.progress)
      adventureBoundary(stage)!.plans!.shift()
      progress.log.unshift(`敌方计划作废：${reason}。`)
      return this.commit(stage,progress,{type:'cancelPlan',planId:plan.id,reason})
    }
    const stage=safeCloneBattleState(this.state)
    if(shortenBlockedAdventureMove(stage)){
      const progress=copy(this.progress);progress.log.unshift('敌人被阻挡，在停下的位置继续后续攻击。')
      const shortened=adventureBoundary(stage)!.plans?.[0]
      if(shortened?.id!==plan.id)return this.commit(stage,progress,{type:'blockedMove',planId:plan.id})
      try{return this.apply(shortened.action,stage,progress)}catch(error){
        if(error instanceof Error&&error.name==='BattleRuleError')return cancel(error.message)
        throw error
      }
    }
    const reason=adventurePlanInvalidReason(this.state,plan)
    if(reason) return cancel(reason)
    try { return this.apply(plan.action) }
    catch(error) {
      // Native rejection (cooldown/status/blocked path) cancels this announced action; never retarget.
      if (error instanceof Error && error.name === 'BattleRuleError') return cancel(error.message)
      throw error
    }
  }

  supply(operation: string, choice: string, revision: number) {
    if (this.state.terminalResult?.winnerPlayerId === this.playerId || this.state.terminalResult?.winnerPlayerIds?.includes(this.playerId)) {
      if (revision !== this.revision) throw new Error('指令已过期，请重试')
    } else this.check(revision)
    if (!adventureSupplies || this.state.pendingOptionSelection || this.state.pendingTargetSelection) throw new Error('请先完成战斗选择')
    const stage = safeCloneBattleState(this.state), progress = copy(this.progress)
    withAdventureSupplyRuntime(stage, () => chooseAdventureSupply(stage, this.playerId, operation, choice, adventureSupplies!))
    return this.commit(stage, progress, { type: 'supply', operation, choice })
  }

  async advanceAct(siteId: string, pieceId: string, revision: number) {
    this.check(revision)
    if (hasAdventureCardChoice(this.state, this.playerId) || this.state.pendingOptionSelection || this.state.pendingTargetSelection) throw new Error('请先完成奖励和当前选择')
    if (getCurrentInputOwnerPlayerId(this.state) !== this.playerId || this.state.turn.phase !== 'action' || adventureBoundary(this.state)?.activeZone) throw new Error('请在探索回合出发')
    const site = this.content.sites.find(item => item.id === siteId && item.kind === 'exit')
    const piece = this.state.pieces.find(item => item.instanceId === pieceId && item.ownerPlayerId === this.playerId && item.currentHp > 0)
    if (!site || !piece || piece.x === null || piece.y === null || Math.abs(piece.x - site.x) + Math.abs(piece.y - site.y) > 1) throw new Error('请移动队长到幕间入口相邻格')
    if (!this.content.zones.filter(z=>!z.optional).every(zone => this.progress.cleared.includes(zone.id))) throw new Error('请先击败本幕首领')
    if (!this.campaign.nextActs?.[this.actIndex]) throw new Error('已经抵达最后一幕')
    if (!this.profile) throw new Error('缺少冒险资源身份，无法切换幕')
    const content = campaignAct(this.campaign, this.actIndex + 1, this.campaign.party.seed)
    const next = await createAdventureState(this.profile, content)
    this.check(revision)
    const oldWorld = adventureBoundary(this.state)!, world = adventureBoundary(next)!
    world.completedRoundOffset = completedAdventureRounds(this.state)
    const captain = this.state.pieces.find(piece => piece.instanceId === oldWorld.party!.captainId && piece.currentHp > 0)
    if (!captain) throw new Error('队长尚未恢复，无法出发')
    const start = content.startingPositions[captain.instanceId]
    next.pieces = [...next.pieces.filter(piece => piece.ownerPlayerId !== this.playerId), { ...copy(captain), ...start }]
    world.party!.reserves = copy(oldWorld.party!.reserves.filter(piece => piece.currentHp > 0))
    world.party!.anchor = { ...start }
    world.party!.deploymentRevision = oldWorld.party!.deploymentRevision + 1
    next.graveyard = copy(this.state.graveyard.filter(piece => piece.ownerPlayerId === this.playerId))
    next.players.find(player => player.playerId === this.playerId)!.hand = copy(this.state.players.find(player => player.playerId === this.playerId)!.hand)
    const cards = adventureCards(this.state)
    if (cards) {
      next.extensions!.adventureCards = copy(cards)
      adventureCards(next)!.suppliedEncounters = []
    }
    cleanupAdventureCards(next)
    for (const card of next.players.find(player => player.playerId === this.playerId)!.hand) {
      if (card.baseActionPointCost !== undefined) card.actionPointCost = card.baseActionPointCost
      delete card.baseActionPointCost
      delete card.temporaryCostReductionTurnNumber
    }
    world.campaignHasNext = this.actIndex + 1 < (this.campaign.nextActs?.length ?? 0)
    const progress = copy(this.progress)
    progress.cleared = []; progress.claimed = []; delete progress.lastReward
    progress.log.unshift(`进入${content.name}。队伍、伤势、金币和卡牌成长保留。`)
    this.actIndex++; this.content = content; this.offers = recruitmentOffers(content)
    return this.commit(next, progress, { type: 'advanceAct', actNumber: this.actIndex + 1 })
  }
}
