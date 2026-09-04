import { randomInt } from 'node:crypto'

import { Room, type Client } from 'colyseus'

import {
  assertGameProfileCompatibleV1,
  getServerGameProfileIdentityV1,
} from '@/lib/content-pipeline/runtime/profile-game-identity'
import { hashBattleState } from '@/lib/game/battle-runner'
import { getBattleStorage } from '@/lib/game/battle-storage'
import { assertSelectableMapId, getSelectableMapCatalog } from '@/lib/game/map-selection'
import { isPlayerSeat, normalizeContentAlignment, type PlayerSeat } from '@/lib/game/match-identity'
import { getAllPieces } from '@/lib/game/piece-repository'
import {
  createPublicBattleSnapshot,
  createPublicBattleTransitionUpdate,
  createPublicRoomSnapshot,
  dispatchRoomBattleAction,
  clearRoomBattleTimeout,
  scheduleRoomBattleTimeout,
  type DispatchRoomBattleActionResult,
  type PublicBattleSnapshot,
} from '@/lib/game/room-battle-actions'
import { startBattleFromLockedRosters } from '@/lib/game/room-battle-start'
import {
  ensureRosterAlignmentMutable,
  getDemoRosterReadiness,
  getRosterErrorPayload,
  lockDemoRosterInStore,
} from '@/lib/game/roster-contract'
import { loadCardById } from '@/lib/game/skills'
import { getAllSkills } from '@/lib/game/skill-repository'
import { parseBattleAuthorityEnvelope } from '@/lib/game/battle-transition'
import type { Player, Room as GameRoom } from '@/lib/game/room-model'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

import {
  CandidateBattleStore,
  type BattleRoomFixtureFactory,
  type CandidateAuthorityRepository,
} from './candidate-battle-store'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_DURABLE_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_RECEIPT_REQUEST_MESSAGE,
  BATTLE_RESYNC_MESSAGE,
  BATTLE_SNAPSHOT_MESSAGE,
  BATTLE_TRANSITION_MESSAGE,
  PRODUCT_ROOM_RPC_MESSAGE,
  PRODUCT_ROOM_RPC_RESULT_MESSAGE,
  PRODUCT_ROOM_UPDATE_MESSAGE,
  createColyseusAppliedReceipt,
  createColyseusRejectedReceipt,
} from './battle-room-protocol'
import { BattleRoomState } from './battle-room-state'
import { ProductBattleStore } from './product-battle-store'

export interface BattleRoomCreateOptions {
  battleId?: string
  creationKey?: string
  product?: boolean
  restore?: boolean
  name?: string
  mapId?: string
  visibility?: 'public' | 'private'
}

export interface BattleRoomJoinOptions {
  playerId: string
  playerName?: string
  accountId?: string
  alignment?: unknown
  profileIdentity?: unknown
}

export interface BattleRoomDependencies {
  repository: CandidateAuthorityRepository
  journal: PostgresAuthorityJournal
  fixtureFactory: BattleRoomFixtureFactory
  claimProductCreation(creationKey: string, roomId: string): string | undefined
  releaseProductCreation(creationKey: string, roomId: string): void
}

type RpcCacheRecord = {
  fingerprint: string
  response?: Record<string, unknown>
  waiters: number
}

export function createBattleRoomClass(dependencies: BattleRoomDependencies) {
  return class BattleRoom extends Room<{ state: BattleRoomState }> {
    maxClients = 8
    autoDispose = false
    private authorityStore?: CandidateBattleStore
    private productStore?: ProductBattleStore
    private productMode = false
    private readonly playerBySession = new Map<string, string>()
    private readonly sessionByPlayer = new Map<string, string>()
    private readonly rpcCache = new Map<string, RpcCacheRecord>()
    private unsubscribeDurable?: () => void

    async onCreate(options: BattleRoomCreateOptions): Promise<void> {
      this.productMode = options?.product === true
      this.state = new BattleRoomState()
      this.onMessage(BATTLE_COMMAND_MESSAGE, (client, message) => this.handleBattleCommand(client, message))
      this.onMessage(BATTLE_RESYNC_MESSAGE, client => this.sendBattleSnapshot(client))
      this.onMessage(PRODUCT_ROOM_RPC_MESSAGE, (client, message) => this.handleProductRpc(client, message))
      this.onMessage(BATTLE_RECEIPT_REQUEST_MESSAGE, (client, message) => this.handleBattleReceiptRequest(client, message))

      if (options?.restore === true) {
        this.productMode = true
        this.roomId = normalizeRequiredId(options.battleId, 'battleId')
        this.authorityStore = await CandidateBattleStore.open({
          roomId: this.roomId,
          repository: dependencies.repository,
          journal: dependencies.journal,
          fixtureFactory: dependencies.fixtureFactory,
        })
        const room = await this.requireGameRoom()
        this.productStore = new ProductBattleStore(
          room,
          dependencies.repository,
          dependencies.journal,
          this.authorityStore,
        )
        this.applyRoomProjection(room)
        this.subscribeDurability()
        await this.publishProductRoom(room)
        await this.setPrivate(room.visibility === 'private')
        await this.scheduleAuthorityTimeout()
        return
      }

      if (this.productMode) {
        // PostgreSQL authority IDs are canonical lowercase. Normalize the
        // generated Colyseus ID before publishing it so matchmaking, envelopes
        // and version-zero persistence all use one exact identifier.
        this.roomId = normalizeRequiredId(options.battleId ?? this.roomId, 'battleId')
        const creationKey = normalizeOptionalId(options.creationKey)
        const existingRoomId = creationKey
          ? dependencies.claimProductCreation(creationKey, this.roomId)
          : undefined
        if (existingRoomId) {
          throw Object.assign(new Error('Duplicate product room creation request'), {
            code: 'ROOM_CREATE_DUPLICATE',
            context: { creationKey, existingRoomId },
          })
        }
        try {
          const mapId = assertSelectableMapId(options.mapId ?? 'open-expanse')
          const room: GameRoom = {
            id: this.roomId,
            name: normalizeRoomName(options.name, this.roomId),
            status: 'waiting',
            createdAt: Date.now(),
            maxPlayers: 2,
            players: [],
            mapId,
            visibility: options.visibility === 'private' ? 'private' : 'public',
            spectators: [],
            currentTurnIndex: 0,
            actions: [],
            version: 0,
          }
          this.productStore = new ProductBattleStore(room, dependencies.repository, dependencies.journal)
          this.applyWaitingProjection(room)
          await this.publishProductRoom(room)
          await this.setPrivate(room.visibility === 'private')
          return
        } catch (error) {
          if (creationKey) dependencies.releaseProductCreation(creationKey, this.roomId)
          throw error
        }
      }

      this.maxClients = 2
      const battleId = normalizeRequiredId(options?.battleId, 'battleId')
      this.roomId = battleId
      this.authorityStore = await CandidateBattleStore.open({
        roomId: battleId,
        repository: dependencies.repository,
        journal: dependencies.journal,
        fixtureFactory: dependencies.fixtureFactory,
      })
      const room = await this.requireGameRoom()
      this.applyRoomProjection(room)
      this.subscribeDurability()
      await this.scheduleAuthorityTimeout()
    }

    async onJoin(client: Client, options: BattleRoomJoinOptions): Promise<void> {
      const playerId = normalizeRequiredId(options?.playerId, 'playerId')
      const activeSessionId = this.sessionByPlayer.get(playerId)
      if (activeSessionId && activeSessionId !== client.sessionId) {
        throw Object.assign(new Error('Player is already connected'), { code: 'BATTLE_PLAYER_ALREADY_CONNECTED' })
      }
      if (this.productMode) {
        await this.joinProductPlayer(client, playerId, options)
        return
      }
      const room = await this.requireGameRoom()
      if (!room.players.some(player => player.id.toLowerCase() === playerId)) {
        throw Object.assign(new Error('Player is not seated in this battle'), { code: 'BATTLE_PLAYER_FORBIDDEN' })
      }
      this.bindSession(client, playerId)
    }

    async onDrop(client: Client): Promise<void> {
      await this.allowReconnection(client, 30)
    }

    async onReconnect(client: Client): Promise<void> {
      const playerId = this.playerBySession.get(client.sessionId)
      if (!playerId || this.sessionByPlayer.get(playerId) !== client.sessionId) {
        throw Object.assign(new Error('Reconnected session is not seated'), { code: 'BATTLE_SESSION_NOT_SEATED' })
      }
      client.send('subscribed', { type: 'subscribed', role: await this.roleFor(playerId) })
      if (this.productMode) await this.broadcastProductRoom()
      await this.sendBattleSnapshot(client)
      await this.scheduleAuthorityTimeout()
    }

    onLeave(client: Client): void {
      const playerId = this.playerBySession.get(client.sessionId)
      this.playerBySession.delete(client.sessionId)
      if (playerId && this.sessionByPlayer.get(playerId) === client.sessionId) {
        this.sessionByPlayer.delete(playerId)
      }
    }

    async onDispose(): Promise<void> {
      clearRoomBattleTimeout(this.roomId)
      this.unsubscribeDurable?.()
      if (this.authorityStore) await this.authorityStore.drainBattleAuthorityPersistence(this.roomId)
    }

    private async joinProductPlayer(
      client: Client,
      playerId: string,
      options: BattleRoomJoinOptions,
    ): Promise<void> {
      const profileIdentity = assertGameProfileCompatibleV1(options.profileIdentity)
      const store = this.requireProductStore()
      const room = await this.requireProductRoom()
      let player = room.players.find(candidate => candidate.id.toLowerCase() === playerId)
      if (!player) {
        if (room.status !== 'waiting' && room.status !== 'ready') {
          throw Object.assign(new Error('Player is not seated in this battle'), { code: 'BATTLE_PLAYER_FORBIDDEN' })
        }
        if (room.players.length >= 2) throw Object.assign(new Error('Room is full'), { code: 'ROOM_FULL' })
        const seat = nextSeat(room.players, playerId)
        player = {
          id: playerId,
          accountId: normalizeOptionalId(options.accountId),
          name: normalizePlayerName(options.playerName, playerId),
          joinedAt: Date.now(),
          seat,
          faction: seat,
          alignment: normalizeContentAlignment(options.alignment),
          profileIdentity,
        }
        room.players.push(player)
        room.hostId ??= playerId
      } else {
        assertGameProfileCompatibleV1(player.profileIdentity)
        const requestedAlignment = normalizeContentAlignment(options.alignment)
        ensureRosterAlignmentMutable(player, requestedAlignment)
        if (requestedAlignment) player.alignment = requestedAlignment
        player.profileIdentity = profileIdentity
        player.name = normalizePlayerName(options.playerName, playerId)
        player.accountId = normalizeOptionalId(options.accountId) ?? player.accountId
      }
      await store.setRoom(this.roomId, room)
      this.bindSession(client, playerId)
      client.send('subscribed', { type: 'subscribed', role: room.hostId === playerId ? 'host' : 'guest' })
      await this.broadcastProductRoom()
      if (room.status === 'in-progress' || room.status === 'finished') await this.sendBattleSnapshot(client)
    }

    private async handleProductRpc(client: Client, message: unknown): Promise<unknown> {
      if (!this.productMode) {
        throw Object.assign(new Error('Product room RPC is unavailable'), { code: 'PRODUCT_ROOM_REQUIRED' })
      }
      const payload = message && typeof message === 'object' ? message as Record<string, unknown> : {}
      const method = String(payload.method ?? '')
      const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {}
      // Native Colyseus request/response does not need an application requestId.
      // Keep the old branch temporarily for already-built setup pages during rollout.
      if (!payload.requestId) return this.dispatchProductRpc(client, method, data)
      const requestId = normalizeRequiredId(payload.requestId, 'requestId')
      const cacheKey = `${client.sessionId}:${requestId}`
      const fingerprint = JSON.stringify([method, data])
      const cached = this.rpcCache.get(cacheKey)
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          client.send(PRODUCT_ROOM_RPC_RESULT_MESSAGE, rpcFailure(requestId, 'RPC_REQUEST_ID_CONFLICT', 'requestId was reused with a different payload'))
        } else if (cached.response) {
          client.send(PRODUCT_ROOM_RPC_RESULT_MESSAGE, cached.response)
        } else {
          cached.waiters += 1
        }
        return undefined
      }
      if (this.rpcCache.size >= 512) this.rpcCache.delete(this.rpcCache.keys().next().value!)
      const record: RpcCacheRecord = { fingerprint, waiters: 0 }
      this.rpcCache.set(cacheKey, record)
      const sendResponse = (response: Record<string, unknown>) => {
        record.response = response
        client.send(PRODUCT_ROOM_RPC_RESULT_MESSAGE, response)
        while (record.waiters > 0) {
          client.send(PRODUCT_ROOM_RPC_RESULT_MESSAGE, response)
          record.waiters -= 1
        }
      }
      try {
        const result = await this.dispatchProductRpc(client, method, data)
        sendResponse({ type: PRODUCT_ROOM_RPC_RESULT_MESSAGE, requestId, ok: true, data: result })
      } catch (error) {
        const rosterError = getRosterErrorPayload(error)
        const details = error as Error & { code?: string; context?: Record<string, unknown> }
        sendResponse({
          type: PRODUCT_ROOM_RPC_RESULT_MESSAGE,
          requestId,
          ok: false,
          code: rosterError?.code ?? details.code ?? 'ROOM_RPC_REJECTED',
          error: rosterError?.message ?? details.message ?? String(error),
          context: rosterError?.context ?? details.context,
        })
      }
      return undefined
    }

    private async dispatchProductRpc(
      client: Client,
      method: string,
      data: Record<string, unknown>,
    ): Promise<unknown> {
      if (method === 'catalog.identity') return { profileIdentity: getServerGameProfileIdentityV1() }
      if (method === 'catalog.maps') return { maps: getSelectableMapCatalog() }
      if (method === 'catalog.pieces') return { pieces: getAllPieces() }
      if (method === 'catalog.skills') return { skills: getAllSkills() }
      if (method === 'catalog.card') {
        const card = loadCardById(String(data.cardId ?? ''))
        if (!card) throw Object.assign(new Error('Card not found'), { code: 'CARD_NOT_FOUND' })
        return card
      }
      if (method === 'rooms.get') {
        const snapshot = publicProductRoom(await this.requireProductRoom())
        client.send(PRODUCT_ROOM_UPDATE_MESSAGE, { type: 'roomUpdate', room: snapshot })
        return snapshot
      }
      if (method === 'rooms.delete') {
        const playerId = this.requireSessionPlayer(client)
        const room = await this.requireProductRoom()
        if (room.hostId?.toLowerCase() !== playerId) {
          throw Object.assign(new Error('Only the host can delete this room'), { code: 'ROOM_HOST_REQUIRED' })
        }
        if (room.status === 'in-progress' || room.status === 'finished') {
          throw Object.assign(new Error('An active battle cannot be deleted'), { code: 'ROOM_DELETE_FORBIDDEN' })
        }
        await this.setPrivate(true)
        this.clock.setTimeout(() => { void this.disconnect() }, 25)
        return { success: true, roomId: this.roomId }
      }
      if (method !== 'rooms.action') throw Object.assign(new Error(`Unsupported product RPC: ${method}`), { code: 'ROOM_RPC_UNSUPPORTED' })
      return this.applyProductRoomAction(client, data)
    }

    private async applyProductRoomAction(client: Client, data: Record<string, unknown>): Promise<unknown> {
      const playerId = this.requireSessionPlayer(client)
      const requestedPlayerId = normalizeRequiredId(data.playerId, 'playerId')
      if (requestedPlayerId !== playerId) {
        throw Object.assign(new Error('Room action player does not match the connected seat'), { code: 'ROOM_PLAYER_MISMATCH' })
      }
      assertGameProfileCompatibleV1(data.profileIdentity)
      const action = String(data.action ?? '')
      const store = this.requireProductStore()
      let room = await this.requireProductRoom()
      const player = room.players.find(candidate => candidate.id.toLowerCase() === playerId)
      if (!player) throw Object.assign(new Error('Player not in room'), { code: 'ROOM_PLAYER_NOT_FOUND' })

      if (action === 'claim-faction') {
        const alignment = normalizeContentAlignment(data.alignment)
        ensureRosterAlignmentMutable(player, alignment)
        if (alignment) player.alignment = alignment
        player.accountId = normalizeOptionalId(data.accountId) ?? player.accountId
        player.name = normalizePlayerName(data.playerName, playerId)
        await store.setRoom(this.roomId, room)
        await this.broadcastProductRoom()
        return { success: true, seat: seatOf(player), faction: seatOf(player), alignment: player.alignment, room: publicProductRoom(room) }
      }

      if (action === 'toggle-ready') {
        if (room.status === 'in-progress' || room.status === 'finished') throw new Error('Battle has already started')
        player.ready = !player.ready
        const allReady = room.players.length === 2 && room.players.every(candidate => candidate.ready === true)
        room.status = allReady ? 'ready' : 'waiting'
        await store.setRoom(this.roomId, room)
        await this.broadcastProductRoom()
        return publicProductRoom(room)
      }

      if (action === 'select-pieces') {
        const locked = await lockDemoRosterInStore(store, this.roomId, {
          playerId,
          alignment: normalizeContentAlignment(data.alignment),
          pieces: data.pieces,
        })
        room = locked.room
        if (getDemoRosterReadiness(room).ready) await this.startProductBattle()
        else await this.broadcastProductRoom()
        const finalRoom = await this.requireProductRoom()
        return {
          success: true,
          duplicate: locked.duplicate,
          locked: true,
          playerId,
          selectedPiecesCount: locked.selectedPiecesCount,
          manifestVersion: locked.manifestVersion,
          room: publicProductRoom(finalRoom),
        }
      }

      if (action === 'leave') {
        if (room.status === 'in-progress') throw new Error('Cannot leave an active battle through room setup')
        room.players = room.players.filter(candidate => candidate.id.toLowerCase() !== playerId)
        if (room.hostId === playerId) room.hostId = room.players[0]?.id
        room.status = 'waiting'
        room.players.forEach(candidate => { candidate.ready = false })
        await store.setRoom(this.roomId, room)
        await this.broadcastProductRoom()
        return { success: true, room: publicProductRoom(room) }
      }

      throw Object.assign(new Error(`Unsupported room action: ${action}`), { code: 'ROOM_ACTION_UNSUPPORTED' })
    }

    private async startProductBattle(): Promise<void> {
      if (this.authorityStore) return
      const store = this.requireProductStore()
      const result = await startBattleFromLockedRosters(store, this.roomId, {
        onDeploymentUpdate: snapshot => this.broadcastBattleSnapshot(snapshot),
      })
      this.authorityStore = store.authority
      if (!this.authorityStore) throw new Error('Product BattleRoom did not establish version-zero authority')
      this.subscribeDurability()
      this.applyRoomProjection(result.room)
      await this.broadcastProductRoom()
      await this.broadcastBattleSnapshot(createPublicBattleSnapshot(result.room))
      await this.scheduleAuthorityTimeout()
    }

    private async handleBattleCommand(client: Client, message: unknown): Promise<void> {
      const seatedPlayerId = this.playerBySession.get(client.sessionId)
      const clientActionId = message && typeof message === 'object'
        ? String((message as Record<string, unknown>).clientActionId ?? '')
        : ''
      if (!seatedPlayerId) {
        client.send(BATTLE_RECEIPT_MESSAGE, rejectedReceipt('BATTLE_SESSION_NOT_SEATED', 'Session is not seated', clientActionId))
        return
      }
      if (!this.authorityStore) {
        client.send(BATTLE_RECEIPT_MESSAGE, rejectedReceipt('BATTLE_NOT_STARTED', 'Battle has not started', clientActionId))
        return
      }
      let submittedAction: unknown
      try {
        const envelope = parseBattleAuthorityEnvelope(message, this.roomId)
        submittedAction = envelope.command
        if (envelope.playerId !== seatedPlayerId) {
          throw Object.assign(new Error('Command player does not match the connected seat'), {
            code: 'BATTLE_PLAYER_MISMATCH',
          })
        }
        const result = await dispatchRoomBattleAction(
          this.authorityStore,
          this.roomId,
          seatedPlayerId,
          envelope.command,
          { expectedAuthorityVersion: envelope.expectedAuthorityVersion, checkpointInterval: 16 },
        )
        client.send(BATTLE_RECEIPT_MESSAGE, createColyseusAppliedReceipt(result))
        this.applySnapshotProjection(result.snapshot, result.transition?.transitionHash)
        if (result.transition) {
          for (const recipient of this.clients) {
            const recipientPlayerId = this.playerBySession.get(recipient.sessionId)
            const update = createPublicBattleTransitionUpdate(result, this.roomId, recipientPlayerId)
            if (update) recipient.send(BATTLE_TRANSITION_MESSAGE, update)
          }
        }
        if (this.productMode) await this.broadcastProductRoom()
        await this.scheduleAuthorityTimeout()
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        client.send(BATTLE_RECEIPT_MESSAGE, createColyseusRejectedReceipt({
          failure,
          clientActionId,
          action: submittedAction,
          authorityVersion: this.state.authorityVersion,
          durableAuthorityVersion: this.state.durableAuthorityVersion,
        }))
      }
    }

    private async handleBattleReceiptRequest(client: Client, message: unknown): Promise<unknown> {
      const playerId = this.requireSessionPlayer(client)
      if (!this.authorityStore) {
        throw Object.assign(new Error('Battle has not started'), { code: 'BATTLE_NOT_STARTED' })
      }
      const payload = message && typeof message === 'object' ? message as Record<string, unknown> : {}
      const clientActionId = normalizeRequiredId(payload.clientActionId, 'clientActionId')
      const receipt = await this.authorityStore.getBattleAuthorityReceipt(this.roomId, clientActionId)
      const room = await this.requireGameRoom()
      const snapshot = createPublicBattleSnapshot(room, playerId)
      return {
        clientActionId,
        outcome: receipt
          ? (receipt.status === 'rejected' || receipt.status === 'resyncRequired' ? 'rejected' : 'applied')
          : 'unknown',
        receipt,
        snapshot: { type: 'stateUpdate', ...snapshot },
      }
    }

    private async sendBattleSnapshot(client: Client): Promise<void> {
      if (!this.authorityStore) return
      const room = await this.requireGameRoom()
      const playerId = this.playerBySession.get(client.sessionId)
      const snapshot = createPublicBattleSnapshot(room, playerId)
      client.send(BATTLE_SNAPSHOT_MESSAGE, { type: 'stateUpdate', ...snapshot })
    }

    private async broadcastBattleSnapshot(snapshot: PublicBattleSnapshot): Promise<void> {
      for (const client of this.clients) {
        const playerId = this.playerBySession.get(client.sessionId)
        if (!this.authorityStore || !playerId) continue
        const room = await this.requireGameRoom()
        client.send(BATTLE_SNAPSHOT_MESSAGE, {
          type: 'stateUpdate',
          ...createPublicBattleSnapshot(room, playerId),
          serverNow: snapshot.serverNow,
        })
      }
    }

    private async requireGameRoom(): Promise<GameRoom> {
      if (!this.authorityStore) throw new Error(`Candidate BattleRoom ${this.roomId} has not started`)
      const room = await this.authorityStore.getRoom(this.roomId)
      if (!room) throw new Error(`Candidate BattleRoom ${this.roomId} is unavailable`)
      return room
    }

    private requireProductStore(): ProductBattleStore {
      if (!this.productStore) throw new Error('Product room store is unavailable')
      return this.productStore
    }

    private async requireProductRoom(): Promise<GameRoom> {
      const room = await this.requireProductStore().getRoom(this.roomId)
      if (!room) throw new Error(`Product room ${this.roomId} is unavailable`)
      return room
    }

    private requireSessionPlayer(client: Client): string {
      const playerId = this.playerBySession.get(client.sessionId)
      if (!playerId) throw Object.assign(new Error('Session is not seated'), { code: 'ROOM_SESSION_NOT_SEATED' })
      return playerId
    }

    private async broadcastProductRoom(): Promise<void> {
      if (!this.productMode) return
      const room = await this.requireProductRoom()
      await this.publishProductRoom(room)
      this.broadcast(PRODUCT_ROOM_UPDATE_MESSAGE, { type: 'roomUpdate', room: publicProductRoom(room) })
    }

    private async publishProductRoom(room: GameRoom): Promise<void> {
      const snapshot = publicProductRoom(room)
      await this.setMetadata({ product: true, room: snapshot, status: snapshot.status, visibility: snapshot.visibility })
    }

    private applyWaitingProjection(room: GameRoom): void {
      this.state.battleId = room.id
      this.state.authorityVersion = 0
      this.state.durableAuthorityVersion = 0
      this.state.stateHash = ''
      this.state.transitionHash = ''
      this.state.phase = 'waiting'
      this.state.roomStatus = room.status
      this.state.turnNumber = 0
      this.state.currentPlayerId = ''
      this.state.terminalStatus = ''
    }

    private applyRoomProjection(room: GameRoom): void {
      const storage = room.battleState as unknown as { state?: PublicBattleSnapshot['state'] } | undefined
      const state = storage?.state
      this.state.battleId = room.id
      this.state.authorityVersion = Number(room.battleAuthorityVersion ?? 0)
      this.state.durableAuthorityVersion = Number(room.battleAuthorityDurableVersion ?? 0)
      this.state.stateHash = state ? hashBattleState(state) : ''
      this.state.transitionHash = room.battleAuthorityTransitionHash ?? ''
      this.state.phase = state?.deployment?.status ?? state?.turn?.phase ?? 'unknown'
      this.state.roomStatus = room.status
      this.state.turnNumber = Number(state?.turn?.turnNumber ?? 0)
      this.state.currentPlayerId = state?.turn?.currentPlayerId ?? ''
      this.state.terminalStatus = state?.terminalResult?.status ?? ''
    }

    private applySnapshotProjection(snapshot: PublicBattleSnapshot, transitionHash?: string): void {
      this.state.authorityVersion = snapshot.authorityVersion
      this.state.durableAuthorityVersion = snapshot.durableAuthorityVersion ?? this.state.durableAuthorityVersion
      this.state.stateHash = snapshot.stateHash
      this.state.transitionHash = transitionHash ?? this.state.transitionHash
      this.state.phase = snapshot.state.deployment?.status ?? snapshot.state.turn?.phase ?? 'unknown'
      this.state.roomStatus = snapshot.state.terminalResult ? 'finished' : 'in-progress'
      this.state.turnNumber = Number(snapshot.state.turn?.turnNumber ?? 0)
      this.state.currentPlayerId = snapshot.state.turn?.currentPlayerId ?? ''
      this.state.terminalStatus = snapshot.state.terminalResult?.status ?? ''
    }

    private subscribeDurability(): void {
      if (!this.authorityStore || this.unsubscribeDurable) return
      this.unsubscribeDurable = this.authorityStore.subscribeDurable(version => {
        this.state.durableAuthorityVersion = version
        this.broadcast(BATTLE_DURABLE_MESSAGE, { battleId: this.roomId, durableAuthorityVersion: version })
      })
    }

    private bindSession(client: Client, playerId: string): void {
      this.playerBySession.set(client.sessionId, playerId)
      this.sessionByPlayer.set(playerId, client.sessionId)
    }

    private async roleFor(playerId: string): Promise<'host' | 'guest'> {
      if (!this.productMode) return 'guest'
      const room = await this.requireProductRoom()
      return room.hostId?.toLowerCase() === playerId ? 'host' : 'guest'
    }

    private async scheduleAuthorityTimeout(): Promise<void> {
      if (!this.authorityStore) return
      await scheduleRoomBattleTimeout(this.authorityStore, this.roomId, {
        setTimeout: (handler, delayMs) => this.clock.setTimeout(() => { void handler() }, delayMs),
        onTransitionCommitted: result => this.publishAuthorityResult(result),
        onCommitted: async snapshot => {
          this.applySnapshotProjection(snapshot)
          await this.broadcastBattleSnapshot(snapshot)
          if (this.productMode) await this.broadcastProductRoom()
        },
      })
    }

    private async publishAuthorityResult(result: DispatchRoomBattleActionResult): Promise<void> {
      this.applySnapshotProjection(result.snapshot, result.transition?.transitionHash)
      if (result.transition) {
        for (const recipient of this.clients) {
          const recipientPlayerId = this.playerBySession.get(recipient.sessionId)
          const update = createPublicBattleTransitionUpdate(result, this.roomId, recipientPlayerId)
          if (update) recipient.send(BATTLE_TRANSITION_MESSAGE, update)
        }
      } else {
        await this.broadcastBattleSnapshot(result.snapshot)
      }
      if (this.productMode) await this.broadcastProductRoom()
    }
  }
}

function publicProductRoom(room: GameRoom) {
  const authorityState = getBattleStorage(room)?.state as { terminalResult?: unknown } | undefined
  const terminal = authorityState?.terminalResult
  const publicRoom = createPublicRoomSnapshot(room)
  return {
    profileIdentity: getServerGameProfileIdentityV1(),
    id: publicRoom.id,
    name: publicRoom.name,
    status: terminal ? 'finished' : publicRoom.status,
    hostId: publicRoom.hostId,
    mapId: publicRoom.mapId,
    maxPlayers: publicRoom.maxPlayers ?? 2,
    authorityVersion: Number(publicRoom.battleAuthorityVersion ?? 0),
    durableAuthorityVersion: Number(publicRoom.battleAuthorityDurableVersion ?? 0),
    visibility: publicRoom.visibility ?? 'public',
    createdAt: publicRoom.createdAt,
    players: publicRoom.players.map(player => ({
      id: player.id,
      accountId: player.accountId,
      name: player.name,
      seat: seatOf(player),
      faction: seatOf(player),
      alignment: player.alignment,
      ready: player.ready === true,
      hasSelectedPieces: player.rosterLocked === true,
      selectedPiecesCount: player.selectedPieces?.length ?? 0,
      rosterLocked: player.rosterLocked === true,
      rosterManifestVersion: player.rosterManifestVersion,
    })),
  }
}

function seatOf(player: Pick<Player, 'seat' | 'faction'>): PlayerSeat | undefined {
  return isPlayerSeat(player.seat) ? player.seat : isPlayerSeat(player.faction) ? player.faction : undefined
}

function nextSeat(players: Player[], playerId: string): PlayerSeat {
  const taken = players
    .filter(player => player.id.toLowerCase() !== playerId)
    .map(seatOf)
    .filter((seat): seat is PlayerSeat => !!seat)
  if (taken.includes('red') && !taken.includes('blue')) return 'blue'
  if (taken.includes('blue') && !taken.includes('red')) return 'red'
  return randomInt(2) === 0 ? 'red' : 'blue'
}

function rejectedReceipt(code: string, message: string, clientActionId = '') {
  return { kind: 'rejected', code, message, clientActionId }
}

function rpcFailure(requestId: string, code: string, error: string) {
  return { type: PRODUCT_ROOM_RPC_RESULT_MESSAGE, requestId, ok: false, code, error }
}

function normalizeRequiredId(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function normalizeOptionalId(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return normalized || undefined
}

function normalizePlayerName(value: unknown, playerId: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || `Player ${playerId.slice(0, 8)}`
}

function normalizeRoomName(value: unknown, roomId: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || `Room ${roomId}`
}
