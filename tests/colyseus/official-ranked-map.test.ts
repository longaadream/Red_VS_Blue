import { matchMaker } from 'colyseus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as configMaps from '@/config/maps'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import * as mapRepository from '@/lib/game/map-repository'
import { createPregame, pregameBattlePlayers } from '@/lib/server/official/pregame'
import { createOfficialServer } from '@/lib/server/official/server'
import { startControlPanel } from '@/lib/server/official/control-panel'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import { EmbeddedPostgresController } from '../../electron-client/embedded-postgres'
import { findFreePort } from '../../electron-client/local-port'

import { FakeAuthorityRepository } from './fake-authority-repository'

const DYNAMIC_MAP_ID = 'resource-pack-map'

describe('official ranked dynamic map startup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts an official room on a newly discovered eligible map', async () => {
    const source = mapRepository.getMapById('open-expanse')
    if (!source) throw new Error('open-expanse fixture is unavailable')
    const dynamicMap = {
      ...structuredClone(source),
      id: DYNAMIC_MAP_ID,
      name: '资源包地图',
      tiles: source.tiles.map(tile => ({ ...tile, id: `${DYNAMIC_MAP_ID}-${tile.x}-${tile.y}` })),
    }
    const loadedMaps = mapRepository.getAllLoadedMaps()
    vi.spyOn(mapRepository, 'getAllLoadedMaps').mockReturnValue([...loadedMaps, dynamicMap])
    const originalGetMap = configMaps.getMap
    vi.spyOn(configMaps, 'getMap').mockImplementation(id => id === DYNAMIC_MAP_ID ? dynamicMap : originalGetMap(id))

    const state = createPregame(
      [DYNAMIC_MAP_ID, 'open-expanse', 'winding-pass'],
      [{ id: 'ranked-red', name: 'Red' }, { id: 'ranked-blue', name: 'Blue' }],
      Date.now(),
      42,
    )
    state.phase = 'starting'
    state.mapId = DYNAMIC_MAP_ID
    const light = getDemoPieceIds().filter(id => getPieceById(id)?.faction === 'good').slice(0, 8)
    const dark = getDemoPieceIds().filter(id => getPieceById(id)?.faction === 'evil').slice(0, 8)
    state.players[0].alignment = 'light'
    state.players[0].pieces = light
    state.players[0].locked = true
    state.players[1].alignment = 'dark'
    state.players[1].pieces = dark
    state.players[1].locked = true
    const officialPlayers = pregameBattlePlayers(state)
    const official = {
      capability: 'dynamic-ranked-map-test',
      authorize: async () => { throw new Error('not used during internal startup') },
      longDrop: async () => undefined,
    }
    const repository = new FakeAuthorityRepository()
    const candidate = createColyseusBattleServer({ repository, official })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    try {
      await matchMaker.createRoom('battle', {
        product: true,
        mode: '1v1',
        battleId: 'dynamic-ranked-map-room',
        playerId: officialPlayers[0].id,
        officialCapability: official.capability,
        officialPlayers,
        mapId: DYNAMIC_MAP_ID,
      })
      const persisted = await repository.restoreRoom('dynamic-ranked-map-room')
      expect(persisted?.room).toMatchObject({
        officialRanked: true,
        mapId: DYNAMIC_MAP_ID,
        status: 'in-progress',
      })
      expect((persisted?.room.battleState as { state?: { map?: { id?: string } } } | undefined)?.state?.map?.id).toBe(DYNAMIC_MAP_ID)
    } finally {
      await candidate.server.gracefullyShutdown(false)
    }
  }, 20_000)
})

async function availablePort(): Promise<number> {
  const probe = await import('node:net').then(({ createServer }) => {
    const server = createServer()
    return new Promise<{ server: ReturnType<typeof createServer>; port: number }>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve({ server, port: typeof address === 'object' && address ? address.port : 0 })
      })
    })
  })
  await new Promise<void>((resolve, reject) => probe.server.close(error => error ? reject(error) : resolve()))
  return probe.port
}

describe.skipIf(process.platform !== 'win32')('official ranked map confirmation persistence', () => {
  it('keeps the ranked gate after restart until an administrator saves the pool', async () => {
    const pg = new EmbeddedPostgresController({
      runtimeRoot: path.resolve('_client-postgres/pgsql'),
      stateRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-ranked-map-pool-')),
      findFreePort,
      portHint: 38971,
      protectSecret: value => Buffer.from(value),
      unprotectSecret: value => value.toString(),
    })
    let app: Awaited<ReturnType<typeof createOfficialServer>> | undefined
    let restarted: Awaited<ReturnType<typeof createOfficialServer>> | undefined
    let panel: Awaited<ReturnType<typeof startControlPanel>> | undefined
    let loaded: ReturnType<typeof vi.spyOn> | undefined
    try {
      const database = await pg.start()
      app = await createOfficialServer({ databaseUrl: database.url, mail: async () => {} })
      const firstPort = await findFreePort(38972)
      await app.start(firstPort)
      const profileIdentity = getServerGameProfileIdentityV1()
      await app.pool.query("INSERT INTO official_accounts(id,email,name,password_hash) VALUES('map-pool-a','map-pool-a@example.test','地图池测试','never')")
      await app.pool.query('UPDATE official_settings SET ranked_maps=$1,maintenance=FALSE', [JSON.stringify(['removed-resource-map', 'open-expanse', 'winding-pass'])])

      await expect(app.ranked.enqueue('map-pool-a', profileIdentity)).rejects.toThrow('地图池')
      expect((await app.pool.query("SELECT count(*)::int AS count FROM official_audit WHERE action='map-pool-invalid'")).rows[0].count).toBe(1)
      await app.close()
      app = undefined

      const source = mapRepository.getMapById('open-expanse')
      if (!source) throw new Error('open-expanse fixture is unavailable')
      const availableAgain = { ...structuredClone(source), id: 'removed-resource-map', name: '恢复后的资源地图' }
      const loadedMaps = mapRepository.getAllLoadedMaps()
      loaded = vi.spyOn(mapRepository, 'getAllLoadedMaps').mockReturnValue([...loadedMaps, availableAgain])

      restarted = await createOfficialServer({ databaseUrl: database.url, mail: async () => {} })
      const restartedPort = await findFreePort(38973)
      await restarted.start(restartedPort)
      panel = await startControlPanel({
        ranked: restarted.ranked,
        mail: {
          status: () => ({ host: 'test', port: 0, sent: 0, failed: 0, checkedAt: null, connected: null, lastSentAt: null, lastFailedAt: null }),
          verify: async () => true,
        },
        assetsRoot: path.resolve('lib/server/official/panel'),
        pagesRoot: path.resolve('data/pages'),
        playerPort: restartedPort,
        shutdown: async () => {},
      })
      const panelUrl = new URL(panel.url)
      const snapshot = async () => JSON.parse(await (await fetch(panelUrl.origin + '/api/snapshot', {
        headers: { Authorization: `Bearer ${panelUrl.hash.slice(1)}`, Origin: panelUrl.origin },
      })).text()) as { rankedMaps: { blocked: boolean; reason?: string } }
      await expect(snapshot()).resolves.toMatchObject({ rankedMaps: { blocked: true, reason: 'ranked-map-pool-requires-admin-confirmation' } })

      await restarted.ranked.administer('map-pool', JSON.stringify(['open-expanse', 'winding-pass', 'narrow-corridors']), '重新确认资源包地图')
      await expect(snapshot()).resolves.toMatchObject({ rankedMaps: { blocked: false } })
    } finally {
      await panel?.close().catch(() => {})
      await restarted?.close().catch(() => {})
      await app?.close().catch(() => {})
      loaded?.mockRestore()
      await pg.stop().catch(() => {})
    }
  }, 90_000)
})
