import { Room, type Client } from 'colyseus'

import { hashBattleState } from '@/lib/game/battle-runner'
import { parseBattleAuthorityEnvelope } from '@/lib/game/battle-transition'
import {
  createPublicBattleTransitionUpdate,
  dispatchRoomBattleAction,
  type PublicBattleSnapshot,
} from '@/lib/game/room-battle-actions'
import type { Room as GameRoom } from '@/lib/game/room-store'
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
  BATTLE_TRANSITION_MESSAGE,
  createColyseusAppliedReceipt,
} from './battle-room-protocol'
import { BattleRoomState } from './battle-room-state'

export interface BattleRoomCreateOptions {
  battleId: string
}

export interface BattleRoomJoinOptions {
  playerId: string
}

export interface BattleRoomDependencies {
  repository: CandidateAuthorityRepository
  journal: PostgresAuthorityJournal
  fixtureFactory: BattleRoomFixtureFactory
}

export function createBattleRoomClass(dependencies: BattleRoomDependencies) {
  return class BattleRoom extends Room<{ state: BattleRoomState }> {
    maxClients = 2
    autoDispose = false
    private authorityStore!: CandidateBattleStore
    private readonly playerBySession = new Map<string, string>()
    private unsubscribeDurable?: () => void

    async onCreate(options: BattleRoomCreateOptions): Promise<void> {
      const battleId = normalizeRequiredId(options?.battleId, 'battleId')
      this.roomId = battleId
      this.authorityStore = await CandidateBattleStore.open({
        roomId: battleId,
        repository: dependencies.repository,
        journal: dependencies.journal,
        fixtureFactory: dependencies.fixtureFactory,
      })
      const room = await this.requireGameRoom()
      this.state = new BattleRoomState()
      this.applyRoomProjection(room)
      this.unsubscribeDurable = this.authorityStore.subscribeDurable(version => {
        this.state.durableAuthorityVersion = version
        this.broadcast(BATTLE_DURABLE_MESSAGE, {
          battleId,
          durableAuthorityVersion: version,
        })
      })
      this.onMessage(BATTLE_COMMAND_MESSAGE, (client, message) => this.handleBattleCommand(client, message))
    }

    async onJoin(client: Client, options: BattleRoomJoinOptions): Promise<void> {
      const playerId = normalizeRequiredId(options?.playerId, 'playerId')
      const room = await this.requireGameRoom()
      if (!room.players.some(player => player.id.toLowerCase() === playerId)) {
        throw Object.assign(new Error('Player is not seated in this battle'), { code: 'BATTLE_PLAYER_FORBIDDEN' })
      }
      if ([...this.playerBySession.values()].includes(playerId)) {
        throw Object.assign(new Error('Player is already connected'), { code: 'BATTLE_PLAYER_ALREADY_CONNECTED' })
      }
      this.playerBySession.set(client.sessionId, playerId)
    }

    onLeave(client: Client): void {
      this.playerBySession.delete(client.sessionId)
    }

    async onDispose(): Promise<void> {
      this.unsubscribeDurable?.()
      await this.authorityStore?.drainBattleAuthorityPersistence(this.roomId)
    }

    private async handleBattleCommand(client: Client, message: unknown): Promise<void> {
      const seatedPlayerId = this.playerBySession.get(client.sessionId)
      if (!seatedPlayerId) {
        client.send(BATTLE_RECEIPT_MESSAGE, rejectedReceipt('BATTLE_SESSION_NOT_SEATED', 'Session is not seated'))
        return
      }
      try {
        const envelope = parseBattleAuthorityEnvelope(message, this.roomId)
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
          {
            expectedAuthorityVersion: envelope.expectedAuthorityVersion,
            checkpointInterval: 16,
          },
        )
        client.send(BATTLE_RECEIPT_MESSAGE, createColyseusAppliedReceipt(result))
        this.applySnapshotProjection(result.snapshot, result.transition?.transitionHash)
        if (result.transition) {
          for (const recipient of this.clients) {
            const recipientPlayerId = this.playerBySession.get(recipient.sessionId)
            const update = createPublicBattleTransitionUpdate(
              result,
              this.roomId,
              recipientPlayerId,
            )
            if (update) recipient.send(BATTLE_TRANSITION_MESSAGE, update)
          }
        }
      } catch (error) {
        const failure = error as Error & { code?: string; receipt?: unknown }
        client.send(BATTLE_RECEIPT_MESSAGE, {
          ...rejectedReceipt(failure.code ?? 'BATTLE_COMMAND_REJECTED', failure.message),
          receipt: failure.receipt,
          authorityVersion: this.state.authorityVersion,
          durableAuthorityVersion: this.state.durableAuthorityVersion,
        })
      }
    }

    private async requireGameRoom(): Promise<GameRoom> {
      const room = await this.authorityStore.getRoom(this.roomId)
      if (!room) throw new Error(`Candidate BattleRoom ${this.roomId} is unavailable`)
      return room
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
      this.state.turnNumber = Number(snapshot.state.turn?.turnNumber ?? 0)
      this.state.currentPlayerId = snapshot.state.turn?.currentPlayerId ?? ''
      this.state.terminalStatus = snapshot.state.terminalResult?.status ?? ''
    }
  }
}

function rejectedReceipt(code: string, message: string) {
  return { kind: 'rejected', code, message }
}

function normalizeRequiredId(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}
