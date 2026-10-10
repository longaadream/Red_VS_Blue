import { describe, expect, it } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import {
  createCloudBotGoalOptions,
} from '@/lib/ai-bot/cloud-bot-cli'
import {
  CloudBotTransport,
  type CloudBotClientLike,
  type CloudBotRoomLike,
  type CloudBotSignal,
} from '@/lib/ai-bot/transport'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '@/lib/game/battle-public-patch'
import type { AIEnvironment, CandidateAction } from '@/lib/game/ai-types'
import type { BattleState } from '@/lib/game/turn'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_RESYNC_MESSAGE,
  BATTLE_SNAPSHOT_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import { decideGoalAction } from '@/lib/ai-bot/goal-policy'

const profileIdentity = getServerGameProfileIdentityV1()

describe('CloudBotTransport budget fallback', () => {
  it('submits one real policy fallback when bounded search time is exhausted inside the decision budget', async () => {
    const room = new BudgetRoom()
    const client: CloudBotClientLike = {
      joinById: async () => room,
      create: async () => room,
    }
    let transportNowValue = 0
    const searchClock = createSearchClock()
    const goalOptions = createCloudBotGoalOptions({
      kind: 'eliminate',
      targetId: 'blue-1',
      maxNodes: 16,
      maxDepth: 3,
      maxTimeMs: 8,
    }, 50)
    const environment = budgetEnvironment()
    let decisionCalls = 0
    let lastDecision: ReturnType<typeof decideGoalAction> | undefined
    let decisionElapsedMs = Number.NaN
    const decide = (state: BattleState, playerId: string) => {
      decisionCalls += 1
      const decisionStartedAt = transportNowValue
      lastDecision = decideGoalAction(state, playerId, {
        ...goalOptions,
        environment,
        hypotheticalSeed: 123,
        now: searchClock,
      })
      transportNowValue += 1
      decisionElapsedMs = transportNowValue - decisionStartedAt
      return lastDecision
    }
    const transport = new CloudBotTransport({
      config: {
        serverUrl: 'http://127.0.0.1:2567',
        roomId: room.roomId,
        playerId: 'red',
        playerName: 'Budget AI',
        alignment: 'light',
        pieces: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        mode: 'official',
        decisionBudgetMs: 50,
        requestTimeoutMs: 500,
      },
      client,
      officialToken: 'local-test-token',
      trustedProfileIdentity: profileIdentity,
      now: () => transportNowValue,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ profileIdentity }),
      }) as unknown as Response,
    })

    try {
      const result = await transport.run({
        decide,
        maxRuntimeMs: 1_000,
        maxActions: 1,
      })

      expect(result).toMatchObject({
        status: 'action-limit',
        actionCount: 1,
        roomId: room.roomId,
        authorityVersion: 1,
      })
      expect(decisionCalls).toBe(1)
      expect(decisionElapsedMs).toBeLessThan(50)
      expect(lastDecision).toMatchObject({
        reason: 'fallback-budget-exhausted',
        action: { type: 'useBasicSkill', playerId: 'red', targetPieceId: 'blue-1' },
        search: {
          status: 'budget-exhausted',
          bounds: { maxTimeMs: 8 },
        },
      })
      expect(lastDecision?.route?.length).toBeGreaterThan(0)
      expect(lastDecision?.search?.stats.transitionsAccepted).toBeGreaterThan(0)
      expect(room.commands).toHaveLength(1)
      expect(room.commands[0]?.command).toMatchObject({
        type: 'useBasicSkill',
        playerId: 'red',
        targetPieceId: 'blue-1',
      })
    } catch (error) {
      expect(error).not.toMatchObject({ code: 'DECISION_BUDGET_EXCEEDED' })
      throw error
    } finally {
      await transport.leave()
    }
  })
})

function createSearchClock(): () => number {
  let value = 0
  return () => value++
}

function budgetEnvironment(): AIEnvironment {
  const candidate: CandidateAction = {
    protocolVersion: 1,
    id: 'attack-blue-1',
    kind: 'basic-skill',
    action: {
      type: 'useBasicSkill',
      playerId: 'red',
      pieceId: 'red-1',
      skillId: 'budget-test-skill',
      targetPieceId: 'blue-1',
    },
  }
  return {
    protocolVersion: 1,
    capabilities: {
      protocolVersion: 1,
      supportedActionTypes: [],
      unsupportedActionTypes: [],
    },
    observe: () => { throw new Error('budget fallback test does not use observe') },
    listLegalActions: () => [candidate],
    simulate: (input) => ({
      protocolVersion: 1,
      accepted: true,
      state: {
        ...input,
        pieces: input.pieces.map(piece => piece.instanceId === 'blue-1'
          ? { ...piece, currentHp: Math.max(0, piece.currentHp - 1) }
          : piece),
      },
      stateHash: 'budget-state',
      transitionHash: 'budget-transition',
      trace: { actionLog: [], stateChanges: [] },
    }),
    isTerminal: state => state.terminalResult !== undefined,
    stateKey: state => state.pieces.map(piece => `${piece.instanceId}:${piece.currentHp}`).join('|'),
  }
}

function budgetState(): BattleState {
  return {
    map: {
      id: 'budget-map',
      name: 'Budget map',
      width: 3,
      height: 1,
      tiles: [0, 1, 2].map(x => ({
        id: `budget-tile-${x}`,
        x,
        y: 0,
        props: { walkable: true, bulletPassable: true, type: 'floor' as const },
      })),
    },
    pieces: [
      {
        instanceId: 'red-1', templateId: 'red-piece', name: 'Red', ownerPlayerId: 'red', faction: 'red',
        currentHp: 10, maxHp: 10, attack: 2, defense: 1, moveRange: 2, x: 0, y: 0,
        isCore: true, skills: [], buffs: [], debuffs: [], ruleTags: [], statusTags: [], rules: [],
      },
      {
        instanceId: 'blue-1', templateId: 'blue-piece', name: 'Blue', ownerPlayerId: 'blue', faction: 'blue',
        currentHp: 8, maxHp: 8, attack: 2, defense: 1, moveRange: 2, x: 2, y: 0,
        isCore: true, skills: [], buffs: [], debuffs: [], ruleTags: [], statusTags: [], rules: [],
      },
    ],
    graveyard: [],
    pieceStatsByTemplateId: {},
    skillsById: {},
    players: [
      { playerId: 'red', chargePoints: 0, actionPoints: 3, maxActionPoints: 3, hand: [], discardPile: [], rules: [], statusTags: [] },
      { playerId: 'blue', chargePoints: 0, actionPoints: 3, maxActionPoints: 3, hand: [], discardPile: [], rules: [], statusTags: [] },
    ],
    turn: {
      currentPlayerId: 'red',
      turnNumber: 1,
      phase: 'action',
      actions: { hasMoved: false, hasUsedBasicSkill: false, hasUsedChargeSkill: false },
    },
    targetingRevision: 1,
  } as unknown as BattleState
}

class BudgetRoom implements CloudBotRoomLike {
  readonly roomId = 'budget-room'
  reconnection = { enabled: true, maxRetries: 1, minDelay: 1, maxDelay: 2 }
  connection = { isOpen: true }
  onReconnect = signal<[]>()
  onDrop = signal<[number?, string?]>()
  onLeave = signal<[number?, string?]>()
  readonly commands: Array<{ command: Record<string, unknown> }> = []
  private readonly messages = new Map<string, Set<(payload: unknown) => void>>()
  private state = budgetState()
  private authorityVersion = 0

  onMessage(type: string, callback: (payload: unknown) => void): () => void {
    const listeners = this.messages.get(type) ?? new Set()
    listeners.add(callback)
    this.messages.set(type, listeners)
    return () => listeners.delete(callback)
  }

  send(type: string, payload?: unknown): void {
    if (type === BATTLE_RESYNC_MESSAGE) this.emitSnapshot()
    if (type !== BATTLE_COMMAND_MESSAGE) return
    const envelope = payload as { clientActionId: string; command: Record<string, unknown> }
    this.commands.push({ command: structuredClone(envelope.command) })
    this.authorityVersion += 1
    this.emit(BATTLE_RECEIPT_MESSAGE, {
      kind: 'applied',
      clientActionId: envelope.clientActionId,
      authorityVersion: this.authorityVersion,
      receipt: {
        clientActionId: envelope.clientActionId,
        status: 'applied',
        authorityVersion: this.authorityVersion,
      },
    })
  }

  request(): Promise<unknown> { return Promise.resolve(undefined) }

  leave(): Promise<unknown> {
    this.connection.isOpen = false
    return Promise.resolve()
  }

  private emit(type: string, payload: unknown): void {
    for (const listener of [...(this.messages.get(type) ?? [])]) listener(payload)
  }

  private emitSnapshot(): void {
    this.emit(BATTLE_SNAPSHOT_MESSAGE, {
      type: 'stateUpdate',
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
      roomId: this.roomId,
      state: this.state,
      authorityVersion: this.authorityVersion,
      seed: 1,
      rootSeed: 1,
      profileIdentity,
      extensions: { hidden: true },
    })
  }
}

function signal<Args extends unknown[]>(): CloudBotSignal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return ((callback: (...args: Args) => void) => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }) as CloudBotSignal<Args>
}
