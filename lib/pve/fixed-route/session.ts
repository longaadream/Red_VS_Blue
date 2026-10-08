import { createRootSeed } from '../../game/rule-runtime'
import { runBattleActionIsolated } from '../../game/battle-runner'
import { safeCloneBattleState, type BattleAction, type BattleState } from '../../game/turn'
import { adventureBoundary } from '../../game/adventure-boundary'
import type { PieceInstance } from '../../game/piece'
import type { GameProfileIdentityV1 } from '../../content-pipeline/runtime/profile-game-identity'
import { adventureCards, hasAdventureCardChoice } from '../../game/adventure-card-state'
import { adventureSupplies, HUMAN } from '../roguelike/content'
import { AdventureSession, type WorldProgress, createAdventureState } from '../roguelike/session'
import { cleanupAdventureCards } from '../roguelike/supplies'
import {
  createFixedRoute,
  createFixedRouteBattleContent,
  loadFixedRouteMap,
  type FixedRouteDefinition,
  type FixedRouteNode,
  type FixedRouteNodeType,
} from './content'

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export type FixedRoutePhase = 'between' | 'battle' | 'result' | 'won' | 'lost'

export interface FixedRouteResult {
  outcome: 'victory' | 'defeat' | 'draw'
  name: string
}

export interface FixedRouteSnapshot {
  state: ReturnType<AdventureSession['snapshot']>['state']
  legalMoves: ReturnType<AdventureSession['snapshot']>['legalMoves']
  content: ReturnType<AdventureSession['snapshot']>['content']
  deployment: ReturnType<AdventureSession['snapshot']>['deployment']
  revision: number
  inputOwner: string
  humanPlayerId: string
  aiPlayerId: string
  world: ReturnType<AdventureSession['snapshot']>['world']
  route: {
    seed: number
    chapterIndex: number
    chapterName: string
    chapterCount: number
    nodeIndex: number
    nodes: Array<{ id: string; type: FixedRouteNodeType; name: string; encounterId?: string }>
    phase: FixedRoutePhase
    lastResult?: FixedRouteResult
    party: PieceInstance[]
    cards: BattleState['players'][number]['hand']
    relics: Array<{ id: string; name: string; description: string }>
    coins: number
    log: string[]
  }
}

export type FixedRouteCommandResult = FixedRouteSnapshot & {
  action?: unknown
  events?: unknown[]
}

/** A native adventure session scoped to one fixed-route battle. */
export class RouteBattleSession extends AdventureSession {
  beginEncounter(expectedRevision: number) {
    this.check(expectedRevision)
    const world = adventureBoundary(this.state)!
    if (world.activeZone) throw new Error('战斗已经开始')
    const zone = this.content.zones[0]
    if (!zone) throw new Error('固定路线战斗缺少战区')
    const stage = safeCloneBattleState(this.state)
    const nextWorld = adventureBoundary(stage)!
    nextWorld.activeZone = copy(zone)
    nextWorld.activeEnemyIds = [...zone.enemyIds]
    return this.commit(stage, copy(this.progress), { type: 'beginEncounter', encounterId: zone.id })
  }

  /** The route wrapper is the only caller; this never exposes a mutable state reference. */
  exportCarry(): BattleState {
    return safeCloneBattleState(this.state)
  }

  exportProgress(): WorldProgress {
    return copy(this.progress)
  }

  /** Hydrate a fresh native battle with the prior route's persistent party state. */
  hydrateCarry(carry: BattleState, progress: WorldProgress): void {
    const stage = safeCloneBattleState(this.state)
    const carried = safeCloneBattleState(carry)
    const stageWorld = adventureBoundary(stage)!
    const carriedWorld = adventureBoundary(carried)!
    const captainId = stageWorld.party?.captainId ?? `${HUMAN}-1`
    const freshCaptain = stage.pieces.find(piece => piece.instanceId === captainId)
    const carriedCaptain = [...carried.pieces, ...carried.graveyard, ...(carriedWorld.party?.reserves ?? [])]
      .find(piece => piece.instanceId === captainId)
    if (!freshCaptain || !carriedCaptain) throw new Error('固定路线队长状态缺失')

    const copiedCaptain = { ...copy(carriedCaptain), x: freshCaptain.x, y: freshCaptain.y }
    stage.pieces = [...stage.pieces.filter(piece => piece.ownerPlayerId !== HUMAN), copiedCaptain]

    const carriedReserves = (carriedWorld.party?.reserves ?? [])
      .filter(piece => piece.currentHp > 0 && piece.instanceId !== captainId)
      .map(piece => ({ ...copy(piece), x: null, y: null }))
    stageWorld.party!.reserves = carriedReserves
    stageWorld.party!.anchor = { x: copiedCaptain.x!, y: copiedCaptain.y! }
    stageWorld.party!.deploymentRevision = (carriedWorld.party?.deploymentRevision ?? 0) + 1
    stageWorld.party!.battleRound = 0
    delete stageWorld.party!.deployedTurn

    stage.graveyard = carried.graveyard
      .filter(piece => piece.ownerPlayerId === HUMAN && piece.instanceId !== captainId)
      .map(piece => ({ ...copy(piece), x: null, y: null }))
    if (carried.extensions?.removedPieces) {
      stage.extensions ??= {}
      stage.extensions.removedPieces = carried.extensions.removedPieces
        .filter((piece: PieceInstance) => piece.ownerPlayerId === HUMAN)
        .map((piece: PieceInstance) => copy(piece))
    } else if (stage.extensions) {
      delete stage.extensions.removedPieces
    }

    const currentPlayer = stage.players.find(player => player.playerId === HUMAN)
    const carriedPlayer = carried.players.find(player => player.playerId === HUMAN)
    if (currentPlayer && carriedPlayer) {
      currentPlayer.hand = copy(carriedPlayer.hand)
      currentPlayer.discardPile = copy(carriedPlayer.discardPile)
    }
    if (carried.extensions?.adventureCards) {
      stage.extensions ??= {}
      stage.extensions.adventureCards = copy(carried.extensions.adventureCards)
    }

    const nextWorld = adventureBoundary(stage)!
    nextWorld.activeZone = undefined
    nextWorld.activeEnemyIds = []
    nextWorld.plans = []
    delete nextWorld.plansTurn
    delete stage.terminalResult
    delete stage.pendingOptionSelection
    delete stage.pendingTargetSelection
    cleanupAdventureCards(stage)
    for (const card of stage.players.find(player => player.playerId === HUMAN)?.hand ?? []) {
      if (card.baseActionPointCost !== undefined) card.actionPointCost = card.baseActionPointCost
      delete card.baseActionPointCost
      delete card.temporaryCostReductionTurnNumber
    }
    this.state = stage
    this.progress = copy(progress)
    this.revision = 0
  }
}

type BattleView = ReturnType<AdventureSession['snapshot']> & { action?: unknown; events?: unknown[] }

export class FixedRouteSession {
  private readonly route: FixedRouteDefinition
  private chapterIndex = 0
  private nodeIndex = 0
  private phase: FixedRoutePhase = 'between'
  private revision = 0
  private lastResult: FixedRouteResult | undefined
  private battle: RouteBattleSession

  private constructor(
    private readonly profile: GameProfileIdentityV1,
    seed: number,
    route: FixedRouteDefinition,
    battle: RouteBattleSession,
  ) {
    this.route = route
    this.battle = battle
    if (route.seed !== seed) throw new Error('固定路线种子不一致')
  }

  static async create(profile: GameProfileIdentityV1, seed = createRootSeed()): Promise<FixedRouteSession> {
    const route = createFixedRoute(seed)
    const battle = await FixedRouteSession.createBattle(profile, route, 0, 0)
    return new FixedRouteSession(profile, seed, route, battle)
  }

  async restart(seed = createRootSeed()): Promise<FixedRouteSession> {
    return FixedRouteSession.create(this.profile, seed)
  }

  get currentRevision(): number {
    return this.revision
  }

  get routeDefinition(): FixedRouteDefinition {
    return copy(this.route)
  }

  snapshot(): FixedRouteSnapshot {
    const view = this.battle.snapshot()
    const carry = this.battle.exportCarry()
    const chapter = this.currentChapter()
    const stateWorld = adventureBoundary(carry)!
    const humanPieces = new Map<string, PieceInstance>()
    for (const piece of [...carry.pieces, ...carry.graveyard, ...(stateWorld.party?.reserves ?? []), ...(carry.extensions?.removedPieces ?? [])]) {
      if (piece.ownerPlayerId === HUMAN && !humanPieces.has(piece.instanceId)) humanPieces.set(piece.instanceId, copy(piece))
    }
    const hand = carry.players.find(player => player.playerId === HUMAN)?.hand ?? []
    const ledger = adventureCards(carry)?.players[HUMAN]
    const relics = (ledger?.relicIds ?? []).map(id => {
      const relic = adventureSupplies?.relics.find(item => item.id === id)
      return relic ? { id: relic.id, name: relic.name, description: relic.description } : { id, name: id, description: '' }
    })
    const nodes = chapter.nodes.map(node => copy(node))
    return {
      state: view.state,
      legalMoves: view.legalMoves,
      content: view.content,
      deployment: view.deployment,
      revision: this.revision,
      inputOwner: view.inputOwner,
      humanPlayerId: view.humanPlayerId,
      aiPlayerId: view.aiPlayerId,
      world: view.world,
      route: {
        seed: this.route.seed,
        chapterIndex: this.chapterIndex,
        chapterName: chapter.name,
        chapterCount: this.route.chapters.length,
        nodeIndex: this.nodeIndex,
        nodes,
        phase: this.phase,
        ...(this.lastResult ? { lastResult: copy(this.lastResult) } : {}),
        party: [...humanPieces.values()],
        cards: copy(hand),
        relics,
        coins: view.world.coins,
        log: copy(view.world.log),
      },
    }
  }

  enter(expectedRevision: number): FixedRouteCommandResult {
    this.checkRevision(expectedRevision)
    if (this.phase !== 'between') throw new Error('当前不在节点之间')
    const node = this.currentNode()
    if (node.type !== 'battle' && node.type !== 'boss') throw new Error('当前节点不需要进入战斗')
    const result = this.battle.beginEncounter(this.battle.currentRevision)
    this.phase = 'battle'
    this.lastResult = undefined
    this.revision += 1
    return this.commandResult(result)
  }

  human(action: BattleAction, expectedRevision: number): FixedRouteCommandResult {
    this.checkRevision(expectedRevision)
    if (this.phase !== 'battle') throw new Error('当前不在战斗阶段')
    const result = this.battle.human(action, this.battle.currentRevision)
    this.syncBattleResult()
    this.revision += 1
    return this.commandResult(result)
  }

  step(expectedRevision: number): FixedRouteCommandResult {
    this.checkRevision(expectedRevision)
    if (this.phase !== 'battle') throw new Error('当前不在战斗阶段')
    const result = this.battle.step(this.battle.currentRevision)
    this.syncBattleResult()
    this.revision += 1
    return this.commandResult(result)
  }

  supply(operation: string, choice: string, expectedRevision: number): FixedRouteCommandResult {
    this.checkRevision(expectedRevision)
    if (this.phase !== 'battle') throw new Error('当前不在战斗阶段')
    const result = this.battle.supply(operation, choice, this.battle.currentRevision)
    this.syncBattleResult()
    this.revision += 1
    return this.commandResult(result)
  }

  async continue(expectedRevision: number): Promise<FixedRouteCommandResult> {
    this.checkRevision(expectedRevision)
    if (this.phase === 'lost') throw new Error('固定路线已经失败')
    if (this.phase === 'won') throw new Error('固定路线已经通关')
    if (this.phase === 'result' && this.lastResult?.outcome !== 'victory') {
      this.phase = 'lost'
      this.revision += 1
      return this.commandResult()
    }
    if (this.phase !== 'between' && this.phase !== 'result') throw new Error('当前不能继续')
    if (this.phase === 'result' && this.lastResult?.outcome === 'victory') {
      // The battle has already settled before a result is published. Reuse its
      // state as the persistent route carry for the next native session.
      const next = this.nextNode()
      if (!next) {
        this.phase = 'won'
        this.revision += 1
        return this.commandResult()
      }
      let nextBattle: RouteBattleSession | undefined
      if (next.node.type === 'battle' || next.node.type === 'boss') {
        const carry = this.battle.exportCarry()
        const progress = this.battle.exportProgress()
        nextBattle = await FixedRouteSession.createBattle(this.profile, this.route, next.chapterIndex, next.nodeIndex, carry, progress)
      }
      this.nodeIndex = next.nodeIndex
      this.chapterIndex = next.chapterIndex
      this.lastResult = undefined
      if (nextBattle) this.battle = nextBattle
      this.phase = 'between'
      this.revision += 1
      return this.commandResult()
    }

    const current = this.currentNode()
    if (current.type === 'battle' || current.type === 'boss') throw new Error('请先进入当前战斗')
    const next = this.nextNode()
    if (!next) {
      this.phase = 'won'
      this.revision += 1
      return this.commandResult()
    }
    let nextBattle: RouteBattleSession | undefined
    if (next.node.type === 'battle' || next.node.type === 'boss') {
      const carry = this.battle.exportCarry()
      const progress = this.battle.exportProgress()
      nextBattle = await FixedRouteSession.createBattle(this.profile, this.route, next.chapterIndex, next.nodeIndex, carry, progress)
    }
    this.nodeIndex = next.nodeIndex
    this.chapterIndex = next.chapterIndex
    this.lastResult = undefined
    if (nextBattle) this.battle = nextBattle
    this.phase = 'between'
    this.revision += 1
    return this.commandResult()
  }

  private checkRevision(expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.revision) throw new Error('指令已过期，请重试')
  }

  private currentChapter() {
    const chapter = this.route.chapters[this.chapterIndex]
    if (!chapter) throw new Error('固定路线章节不存在')
    return chapter
  }

  private currentNode(): FixedRouteNode {
    const node = this.currentChapter().nodes[this.nodeIndex]
    if (!node) throw new Error('固定路线节点不存在')
    return node
  }

  private nextNode(): { chapterIndex: number; nodeIndex: number; node: FixedRouteNode } | undefined {
    const chapter = this.currentChapter()
    if (this.nodeIndex + 1 < chapter.nodes.length) return { chapterIndex: this.chapterIndex, nodeIndex: this.nodeIndex + 1, node: chapter.nodes[this.nodeIndex + 1]! }
    if (this.chapterIndex + 1 >= this.route.chapters.length) return undefined
    return { chapterIndex: this.chapterIndex + 1, nodeIndex: 0, node: this.route.chapters[this.chapterIndex + 1]!.nodes[0]! }
  }

  private syncBattleResult(): void {
    const state = this.battle.exportCarry()
    const terminal = state.terminalResult
    if (!terminal) return
    if (terminal.winnerPlayerId === HUMAN || terminal.winnerPlayerIds?.includes(HUMAN)) {
      if (hasAdventureCardChoice(state, HUMAN) || state.pendingOptionSelection || state.pendingTargetSelection) return
      this.phase = 'result'
      this.lastResult = { outcome: 'victory', name: this.currentNode().name }
      return
    }
    this.phase = 'result'
    this.lastResult = { outcome: terminal.winnerPlayerId === null ? 'draw' : 'defeat', name: this.currentNode().name }
  }

  private commandResult(result?: BattleView): FixedRouteCommandResult {
    const snapshot = this.snapshot()
    return { ...snapshot, ...(result ? { action: result.action, events: result.events } : {}) }
  }

  private static async createBattle(
    profile: GameProfileIdentityV1,
    route: FixedRouteDefinition,
    chapterIndex: number,
    nodeIndex: number,
    carry?: BattleState,
    progress?: WorldProgress,
  ): Promise<RouteBattleSession> {
    const node = route.chapters[chapterIndex]?.nodes[nodeIndex]
    if (!node || !node.encounterId) throw new Error('固定路线战斗节点不存在')
    const spec = route.chapters[chapterIndex]!.battles[node.encounterId]
    if (!spec) throw new Error('固定路线战斗配置不存在')
    const map = await loadFixedRouteMap(spec.mapId)
    const content = createFixedRouteBattleContent(route, chapterIndex, node, map)
    const initialized = await createAdventureState(profile, content, map)
    const preview = runBattleActionIsolated(initialized, { type: 'beginPhase' }, { rootSeed: route.seed }).state
    const battle = new RouteBattleSession(preview, content, profile)
    if (carry && progress) battle.hydrateCarry(carry, progress)
    return battle
  }
}

export async function createFixedRouteSession(profile: GameProfileIdentityV1, seed = createRootSeed()): Promise<FixedRouteSession> {
  return FixedRouteSession.create(profile, seed)
}
