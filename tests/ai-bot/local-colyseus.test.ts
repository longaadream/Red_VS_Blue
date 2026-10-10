import { createServer } from 'node:net'

import { Client as ColyseusClient } from '@colyseus/sdk'
import { matchMaker } from 'colyseus'
import { describe, expect, it } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import {
  CloudBotTransport,
  type CloudBotClientLike,
} from '@/lib/ai-bot/transport'
import { BATTLE_TRANSITION_MESSAGE } from '@/lib/server/colyseus/battle-room-protocol'
import { createDevelopmentBattleRoom } from '@/lib/server/colyseus/development-battle-fixture'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import { FakeAuthorityRepository } from '../colyseus/fake-authority-repository'

const profileIdentity = getServerGameProfileIdentityV1()
const pieces = [
  'arthas', 'dark-aizen', 'dark-grimmjow', 'dark-muzan',
  'dark-ulquiorra', 'guldan', 'kiljaedan', 'reaper',
]

describe('CloudBotTransport against a native local Colyseus room', () => {
  it('binds one player session and completes move, phase advance, receipt, and resync over the SDK', async () => {
    const candidate = createColyseusBattleServer({
      repository: new FakeAuthorityRepository(),
      fixtureFactory: createDevelopmentBattleRoom,
      reconnectGraceMs: 250,
    })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')

    const serverUrl = `http://127.0.0.1:${port}`
    const hostClient = new ColyseusClient(serverUrl)
    const botClient = new ColyseusClient(serverUrl)
    const duplicateClient = new ColyseusClient(serverUrl)
    const hostRoom = await hostClient.create('battle', {
      battleId: 'red249-local-native-sdk',
      playerId: 'player-blue',
    })
    const localRoom = matchMaker.getLocalRoomById(hostRoom.roomId) as unknown as { maxClients: number }
    localRoom.maxClients = 3
    const bot = new CloudBotTransport({
      config: {
        serverUrl,
        roomId: hostRoom.roomId,
        playerId: 'player-red',
        playerName: 'RED-249 local AI',
        alignment: 'light',
        pieces,
        // This fixture starts directly in battle; it has no product lobby RPC.
        // Official-mode transport skips direct lobby setup. Its fake token is
        // not authenticated by this local non-product room; account validation
        // is covered separately by the session/lobby tests.
        mode: 'official',
        requestTimeoutMs: 2_000,
        decisionBudgetMs: 500,
      },
      client: botClient as unknown as CloudBotClientLike,
      officialToken: 'red249-local-fixture-token',
      trustedProfileIdentity: profileIdentity,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ profileIdentity }),
      }) as unknown as Response,
    })

    try {
      const connected = await bot.connect()
      bot.activeRoom?.onMessage(BATTLE_TRANSITION_MESSAGE, () => {})
      expect(connected).toMatchObject({ roomId: hostRoom.roomId, authorityVersion: 0 })
      expect(connected.state).not.toHaveProperty('extensions')

      await expect(duplicateClient.joinById(hostRoom.roomId, {
        playerId: 'player-red',
        profileIdentity,
      })).rejects.toThrow(/already connected/i)

      const firstAction = bot.sendAction({
        type: 'move',
        playerId: 'player-red',
        pieceId: 'red-core',
        toX: 1,
        toY: 0,
      })
      await expect(bot.sendAction({ type: 'endTurn', playerId: 'player-red' }))
        .rejects.toMatchObject({ code: 'ACTION_IN_FLIGHT' })

      const moveResult = await firstAction
      expect(moveResult).toMatchObject({
        outcome: 'applied',
        receipt: { kind: 'applied' },
        snapshot: { authorityVersion: 1 },
      })
      expect(moveResult.snapshot.state.pieces.find(piece => piece.instanceId === 'red-core'))
        .toMatchObject({ x: 1, y: 0 })

      await expect(bot.resync()).resolves.toMatchObject({
        roomId: hostRoom.roomId,
        authorityVersion: 1,
      })

      const endTurn = await bot.sendAction({ type: 'endTurn', playerId: 'player-red' })
      expect(endTurn).toMatchObject({ outcome: 'applied', receipt: { kind: 'applied' } })

      const phaseAdvance = await bot.sendAction({ type: 'beginPhase' })
      expect(phaseAdvance).toMatchObject({
        outcome: 'applied',
        receipt: { kind: 'applied' },
        snapshot: { authorityVersion: 3 },
      })
    } finally {
      await bot.leave()
      if (hostRoom.connection.isOpen) await hostRoom.leave()
      await candidate.server.gracefullyShutdown(false)
    }
  }, 20_000)
})

async function availablePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) => {
    probe.close(error => error ? reject(error) : resolve())
  })
  return port
}
