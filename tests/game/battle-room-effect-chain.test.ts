import { createServer } from 'node:net'

import { Client as ColyseusClient, type Room as ColyseusClientRoom } from '@colyseus/sdk'
import { describe, expect, it } from 'vitest'

import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '@/lib/game/battle-public-patch'
import { getBattleStorage } from '@/lib/game/battle-storage'
import { getActiveEffectChain } from '@/lib/game/effect-batch'
import {
  closeRoomRuleRuntime,
  restoreRoomRuleRuntime,
} from '@/lib/game/room-rule-runtime'
import { dealDamage } from '@/lib/game/skills'
import type { TriggerRule } from '@/lib/game/triggers'
import type { BattleState } from '@/lib/game/turn'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_TRANSITION_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'
import { FakeAuthorityRepository } from '../colyseus/fake-authority-repository'

describe('RED-139 real Colyseus BattleRoom boundary', () => {
  it('rejects an attached EffectChain fatal without a transition, then emits a JSON-safe normal transition', async () => {
    const roomId = 'red139-colyseus-effect-chain-fatal'
    const repository = new FakeAuthorityRepository()
    const journal = new PostgresAuthorityJournal(repository, {
      maxBatchSize: 8,
      maxDwellMs: 5,
      maxAttempts: 1,
    })
    const candidate = createColyseusBattleServer({ repository, journal })
    const port = await availablePort()
    let room: ColyseusClientRoom | undefined
    let listening = false

    try {
      await candidate.server.listen(port, '127.0.0.1')
      listening = true
      const client = new ColyseusClient(`ws://127.0.0.1:${port}`)
      room = await client.joinOrCreate('battle', {
        battleId: roomId,
        playerId: 'player-red',
      })

      const runtime = restoreRoomRuleRuntime(roomId)
      const fatalRule = effectChainFatalRule(roomId)
      runtime.executionContext.triggerSystem.addRule(fatalRule)
      const before = await repository.restoreRoom(roomId)
      expect(before).toBeDefined()
      const beforeState = requireBattleState(before!.room)
      const beforeStateJson = JSON.stringify(beforeState)
      const transitions: BattleTransitionMessage[] = []
      const unsubscribeTransitions = room.onMessage(BATTLE_TRANSITION_MESSAGE, message => {
        transitions.push(message as BattleTransitionMessage)
      })

      const fatalActionId = `${roomId}:fatal`
      const fatalReceiptPromise = nextReceipt(room, fatalActionId)
      room.send(BATTLE_COMMAND_MESSAGE, envelope(
        roomId,
        'player-red',
        0,
        fatalActionId,
        {
          type: 'endTurn',
          playerId: 'player-red',
          clientActionId: fatalActionId,
        },
      ))
      const fatalReceipt = await fatalReceiptPromise

      expect(fatalReceipt).toMatchObject({
        kind: 'rejected',
        code: 'RVB_EFFECT_CHAIN_STATE_INVALID',
        authorityVersion: 0,
        receipt: {
          clientActionId: fatalActionId,
          status: 'rejected',
          authorityVersion: 0,
          code: 'RVB_EFFECT_CHAIN_STATE_INVALID',
        },
      })
      expect(room.state.authorityVersion).toBe(0)
      expect(transitions).toHaveLength(0)
      expect(fatalRule.limits).toEqual({ maxUses: 1, uses: 0, currentCooldown: 0 })
      const afterFatal = await repository.restoreRoom(roomId)
      expect(afterFatal).toBeDefined()
      expect(afterFatal!.room.battleAuthorityVersion).toBe(0)
      expect(afterFatal!.transitions).toEqual([])
      expect(JSON.stringify(requireBattleState(afterFatal!.room))).toBe(beforeStateJson)

      runtime.executionContext.triggerSystem.removeRule(fatalRule.id)
      const normalActionId = `${roomId}:normal`
      const normalReceiptPromise = nextReceipt(room, normalActionId)
      const normalTransitionPromise = nextTransition(room, normalActionId)
      room.send(BATTLE_COMMAND_MESSAGE, envelope(
        roomId,
        'player-red',
        0,
        normalActionId,
        {
          type: 'endTurn',
          playerId: 'player-red',
          clientActionId: normalActionId,
        },
      ))
      const [normalReceipt, normalTransition] = await Promise.all([
        normalReceiptPromise,
        normalTransitionPromise,
      ])

      expect(normalReceipt).toMatchObject({
        kind: 'applied',
        authorityVersion: 1,
        receipt: {
          clientActionId: normalActionId,
          status: 'applied',
          authorityVersion: 1,
        },
      })
      expect(normalTransition).toMatchObject({
        type: 'battleTransition',
        roomId,
        fromVersion: 0,
        toVersion: 1,
        receipt: { clientActionId: normalActionId, status: 'applied' },
      })
      expect(() => structuredClone(normalTransition)).not.toThrow()
      expect(JSON.parse(JSON.stringify(normalTransition))).toMatchObject({
        roomId,
        fromVersion: 0,
        toVersion: 1,
        receipt: { clientActionId: normalActionId },
      })
      await expect.poll(() => room?.state.authorityVersion, { timeout: 3_000 }).toBe(1)
      const roomProjection = JSON.parse(JSON.stringify(room.state)) as Record<string, unknown>
      expect(roomProjection).toMatchObject({ battleId: roomId, authorityVersion: 1 })
      expect(() => structuredClone(roomProjection)).not.toThrow()

      await journal.drain(roomId)
      const persisted = await repository.restoreRoom(roomId)
      expect(persisted).toBeDefined()
      expect(persisted!.room.battleAuthorityVersion).toBe(1)
      expect(persisted!.transitions).toHaveLength(1)
      const persistedState = requireBattleState(persisted!.room)
      expect(() => structuredClone(persistedState)).not.toThrow()
      expect(JSON.parse(JSON.stringify(persistedState))).toEqual(persistedState)
      expect(getActiveEffectChain(persistedState)).toBeUndefined()
      expect(transitions).toHaveLength(1)
      unsubscribeTransitions()
    } finally {
      if (room) await room.leave()
      if (listening) await candidate.server.gracefullyShutdown(false)
      closeRoomRuleRuntime(roomId, 'red139-test-complete')
    }
  }, 20_000)
})

function effectChainFatalRule(roomId: string): TriggerRule {
  return {
    id: `room-effect-chain-fatal:${roomId}`,
    name: `Room EffectChain fatal ${roomId}`,
    description: 'RED-139 real BattleRoom rollback fixture',
    trigger: { type: 'endTurn' },
    limits: { maxUses: 1, uses: 0, currentCooldown: 0 },
    effect(battle) {
      const attacker = battle.pieces.find(piece => piece.ownerPlayerId === 'player-red')
      const target = battle.pieces.find(piece => piece.ownerPlayerId === 'player-blue')
      if (!attacker || !target) throw new Error('EffectChain fatal fixture is missing combatants')
      dealDamage(attacker, target, Number.NaN, 'true', battle, 'room-effect-chain-fatal')
      return { success: true }
    },
  }
}

function requireBattleState(room: { battleState?: unknown }): BattleState {
  const storage = getBattleStorage(room as never)
  if (!storage) throw new Error('RED-139 BattleRoom fixture has no battle storage')
  return storage.state as BattleState
}

function envelope(
  roomId: string,
  playerId: string,
  expectedAuthorityVersion: number,
  clientActionId: string,
  command: Record<string, unknown>,
) {
  return {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    roomId,
    playerId,
    expectedAuthorityVersion,
    clientActionId,
    command,
  }
}

interface BattleReceiptMessage {
  kind: string
  code?: string
  authorityVersion?: number
  receipt?: {
    clientActionId?: string
    status?: string
    authorityVersion?: number
    code?: string
  }
}

interface BattleTransitionMessage {
  type?: string
  roomId?: string
  fromVersion?: number
  toVersion?: number
  patch?: unknown
  receipt?: { clientActionId?: string; status?: string }
}

function nextReceipt(room: ColyseusClientRoom, clientActionId: string): Promise<BattleReceiptMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${clientActionId}`)), 3_000)
    const unsubscribe = room.onMessage(BATTLE_RECEIPT_MESSAGE, message => {
      if (message?.receipt?.clientActionId !== clientActionId) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(message as BattleReceiptMessage)
    })
  })
}

function nextTransition(room: ColyseusClientRoom, clientActionId: string): Promise<BattleTransitionMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for transition ${clientActionId}`)), 3_000)
    const unsubscribe = room.onMessage(BATTLE_TRANSITION_MESSAGE, message => {
      if (message?.receipt?.clientActionId !== clientActionId) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(message as BattleTransitionMessage)
    })
  })
}

async function availablePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}
