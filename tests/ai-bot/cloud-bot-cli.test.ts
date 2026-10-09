import { describe, expect, it, vi } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import {
  createCloudBotGoalOptions,
  parseCloudBotConfig,
  executeCloudBot,
  publicRunResult,
} from '@/lib/ai-bot/cloud-bot-cli'
import type { CloudBotRoomLike, CloudBotSignal } from '@/lib/ai-bot/transport'
import { BATTLE_SNAPSHOT_MESSAGE, BATTLE_RESYNC_MESSAGE } from '@/lib/server/colyseus/battle-room-protocol'

const profileIdentity = getServerGameProfileIdentityV1()
const pieces = ['piece-a', 'piece-b', 'piece-c', 'piece-d', 'piece-e', 'piece-f', 'piece-g', 'piece-h']

function config(overrides: Record<string, unknown> = {}) {
  return {
    serverUrl: 'http://127.0.0.1:2567', mode: 'official', alignment: 'light', pieces,
    maxRuntimeMs: 10_000, maxActions: 1, ...overrides,
  }
}

function signal<Args extends unknown[]>(): CloudBotSignal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return ((callback: (...args: Args) => void) => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }) as CloudBotSignal<Args>
}

function terminalState() {
  return {
    map: {
      id: 'test-map', name: 'Test map', width: 1, height: 1,
      tiles: [{ id: 'tile-0', x: 0, y: 0, props: { walkable: true, bulletPassable: true, type: 'floor' } }],
    },
    pieces: [], graveyard: [], pieceStatsByTemplateId: {}, skillsById: {}, players: [],
    turn: { currentPlayerId: 'account-1', turnNumber: 1, phase: 'action', actions: { hasMoved: false, hasUsedBasicSkill: false, hasUsedChargeSkill: false } },
    targetingRevision: 0,
    terminalResult: { status: 'finished', winnerPlayerId: 'account-1', reason: 'test' },
  }
}

class TerminalRoom implements CloudBotRoomLike {
  roomId = 'ranked-match-1'
  reconnection = { enabled: true, maxRetries: 1, minDelay: 1, maxDelay: 2 }
  onReconnect = signal<[]>()
  onDrop = signal<[number?, string?]>()
  onLeave = signal<[number?, string?]>()
  private messages = new Map<string, (payload: unknown) => void>()
  leaveCalls = 0

  onMessage(type: string, callback: (payload: unknown) => void): () => void {
    this.messages.set(type, callback)
    return () => this.messages.delete(type)
  }

  send(type: string): void {
    if (type === BATTLE_RESYNC_MESSAGE) this.messages.get(BATTLE_SNAPSHOT_MESSAGE)?.({
      type: 'stateUpdate', protocolVersion: 3,
      authorityBuildId: 'rvb-authority-v3-chunked-sha256-1', roomId: this.roomId,
      state: terminalState(), authorityVersion: 0, seed: 1, rootSeed: 2,
      profileIdentity, extensions: { private: true },
    })
  }

  request(): Promise<unknown> { return Promise.resolve(undefined) }
  leave(): Promise<unknown> { this.leaveCalls += 1; return Promise.resolve() }
}

describe('cloud bot CLI configuration and execution', () => {
  it('maps the configured target instance into the policy goal without forwarding authority seed fields', () => {
    const options = createCloudBotGoalOptions({ kind: 'eliminate', targetInstanceId: 'blue-1', rootSeed: 999, maxNodes: 16 }, 80)
    expect(options).toMatchObject({ goal: { kind: 'eliminate', targetId: 'blue-1' }, maxNodes: 16, maxTimeMs: 56 })
    expect(options).not.toHaveProperty('rootSeed')
  })

  it('validates official config offline and derives room identity from the official lobby', async () => {
    const official = parseCloudBotConfig(config())
    expect(official.roomId).toBeUndefined()
    expect(official.playerId).toBe('')
    expect(() => parseCloudBotConfig({ ...config(), token: 'do-not-put-secrets-in-json' })).toThrowError(expect.objectContaining({ code: 'CONFIG_SECRET_FORBIDDEN' }))
    expect(() => parseCloudBotConfig({ ...config(), accountId: 'account-a', playerId: 'account-b' })).toThrowError(expect.objectContaining({ code: 'OFFICIAL_ID_CONFLICT' }))
    expect(() => parseCloudBotConfig({ ...config(), serverUrl: 'http://public.example.test:2567' })).toThrowError(expect.objectContaining({ code: 'SERVER_URL_INSECURE' }))
    expect(() => parseCloudBotConfig({ serverUrl: 'http://127.0.0.1:2567', mode: 'direct', alignment: 'light', pieces })).toThrowError(expect.objectContaining({ code: 'ROOM_SELECTION_REQUIRED' }))

    const room = new TerminalRoom()
    const client = {
      joinById: vi.fn(async () => room),
      create: vi.fn(async () => room),
    }
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/catalog/identity')) return { ok: true, status: 200, json: async () => ({ profileIdentity }) } as unknown as Response
      if (url.endsWith('/official/me')) return { ok: true, status: 200, json: async () => ({ account: { id: 'account-1', name: 'AI Account' }, matchId: 'ranked-match-1', queued: false }) } as unknown as Response
      if (url.endsWith('/official/pregame/ranked-match-1')) return { ok: true, status: 200, json: async () => ({ phase: 'battle', players: [{ id: 'account-1', locked: true, revision: 3 }] }) } as unknown as Response
      throw new Error(`unexpected URL ${url}`)
    })

    const result = await executeCloudBot(official, {
      env: { ...process.env, RVB_BOT_OFFICIAL_TOKEN: 'session-token' },
      fetchFn,
      client,
      trustedProfileIdentity: profileIdentity,
      decide: () => ({}),
    })
    expect(result.status).toBe('terminal')
    expect(room.leaveCalls).toBe(1)
    expect(client.joinById).toHaveBeenCalledWith('ranked-match-1', expect.objectContaining({
      product: true, playerId: 'account-1', playerName: 'AI Account', officialToken: 'session-token',
    }))
    expect(calls.every(call => !call.url.includes('session-token'))).toBe(true)
    expect(publicRunResult(result)).not.toHaveProperty('lastSnapshot')
  })
})
