import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '../../app/api/relay-battle-init/route'
import { DEPLOYMENT_DURATION_MS } from '../../lib/game/deployment'
import { SELECTABLE_MAP_IDS } from '../../lib/game/map-selection'
import { handleMobileServerRequest, handleRelayBattleInit } from '../../mobile-server/mobile-server-entry'
import {
  STANDALONE_SELECTABLE_MAP_CATALOG,
  STANDALONE_SELECTABLE_MAP_IDS,
  validateStandaloneMapId,
} from '../../relay-server/src/types'

const lightRoster = [
  'ana',
  'anduin',
  'blue-kenshin',
  'blue-minato',
  'blue-naruto',
  'blue-tirion-fordring',
  'blue-watcher',
  'hashirama-edo',
]

const darkRoster = [
  'arthas',
  'guldan',
  'kiljaedan',
  'reaper',
  'red-blackwidow',
  'red-doomsday-fist',
  'red-hidan',
  'red-illidan',
]

describe('relay deployment initialization', () => {
  const players = [
    { id: 'alice', faction: 'red' as const, alignment: 'light' as const, pieces: lightRoster.map(templateId => ({ templateId })) },
    { id: 'bob', faction: 'blue' as const, alignment: 'dark' as const, pieces: darkRoster.map(templateId => ({ templateId })) },
  ]
  const selectableMapIds = [
    'large-hole-arena',
    'open-expanse',
    'winding-pass',
    'narrow-corridors',
  ] as const

  it.each(selectableMapIds)('uses the submitted %s map in Next Relay initialization', async mapId => {
    const request = new NextRequest('http://localhost/api/relay-battle-init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mapId,
        players,
      }),
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.state.map.id).toBe(mapId)
    expect(body.state.extensions.playerAlignments).toEqual({ alice: 'light', bob: 'dark' })
    expect(body.state.pieces.filter((piece: { isCore?: boolean }) => piece.isCore)).toHaveLength(2)
    expect(body.state.deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'awaiting-reserve-deploy',
      activePlayerId: 'alice',
      reserveCounts: { alice: 7, bob: 6 },
      choices: {},
      locks: {},
      revision: 1,
    })
    expect(body.state.turn.currentPlayerId).toBe('alice')
    expect(body.state.gameStartFired).toBe(true)
    expect(body.authorityVersion).toBe(1)
    expect(body.state.extensions.debugBattle.actionLog[0].deployment.authorityVersion).toBe(1)
    expect(body.stateHash).toEqual(expect.any(String))
  })

  it.each(selectableMapIds)('uses the submitted %s map in Android Relay initialization', async mapId => {
    const body = JSON.parse(await handleRelayBattleInit({
      mapId,
      players,
    }))

    expect(body._status).toBe(200)
    expect(body.authorityVersion).toBe(1)
    expect(body.stateHash).toEqual(expect.any(String))
    expect(body.state.map.id).toBe(mapId)
    expect(body.state.extensions.playerAlignments).toEqual({ alice: 'light', bob: 'dark' })
    expect(body.state.pieces.filter((piece: { isCore?: boolean }) => piece.isCore)).toHaveLength(16)
    expect(body.state.deployment).toMatchObject({
      mode: 'legacy-reroll-v1',
      status: 'awaiting-locks',
      choices: {},
      locks: {
        alice: { locked: false },
        bob: { locked: false },
      },
      revision: 0,
    })
    expect(body.state.deployment.deadlineAt - body.state.deployment.startedAt).toBe(DEPLOYMENT_DURATION_MS)
    expect(body.state.deployment).not.toHaveProperty('activePlayerId')
    expect(body.state.deployment).not.toHaveProperty('reserves')
    expect(body.state.deployment).not.toHaveProperty('reserveCounts')
    expect(body.state.deployment).not.toHaveProperty('offerPieceIds')
    expect(body.state.deployment).not.toHaveProperty('offerPieces')
    expect(body.state.turn.currentPlayerId).toBe('alice')
    expect(body.state.gameStartFired).toBeFalsy()
    expect(body.state.extensions.debugBattle.actionLog[0].deployment.authorityVersion).toBe(1)
  })

  it.each([
    { mapId: undefined, code: 'MAP_ID_REQUIRED' },
    { mapId: 'unknown-map', code: 'MAP_NOT_SELECTABLE' },
    { mapId: 'large-battlefield', code: 'MAP_NOT_SELECTABLE' },
    { mapId: 'large-trap-arena', code: 'MAP_NOT_SELECTABLE' },
    { mapId: '../large-hole-arena', code: 'MAP_NOT_SELECTABLE' },
  ])('rejects invalid Relay map input $mapId before initialization', async ({ mapId, code }) => {
    const request = new NextRequest('http://localhost/api/relay-battle-init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapId, players }),
    })

    const response = await POST(request)
    const body = await response.json()
    const mobileBody = JSON.parse(await handleRelayBattleInit({ mapId, players }))

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ code, error: expect.any(String) })
    expect(mobileBody).toMatchObject({ _status: 400, code, error: expect.any(String) })
  })
  it('validates and persists Android room map selection before writes', async () => {
    const before = JSON.parse(await handleMobileServerRequest('GET', '/api/lobby', {}))
    const initialCount = before.rooms.length

    for (const mapId of selectableMapIds) {
      const created = JSON.parse(await handleMobileServerRequest('POST', '/api/lobby', {
        name: 'Map persistence room',
        hostId: `host-${mapId}`,
        playerName: 'Host',
        mapId,
      }))
      expect(created).toMatchObject({ _status: 201, mapId })
    }

    const maps = JSON.parse(await handleMobileServerRequest('GET', '/api/maps', {}))
    expect(maps.maps.map((map: { id: string }) => map.id)).toEqual(selectableMapIds)

    const afterValid = JSON.parse(await handleMobileServerRequest('GET', '/api/lobby', {}))
    expect(afterValid.rooms).toHaveLength(initialCount + selectableMapIds.length)

    for (const { mapId, code } of [
      { mapId: undefined, code: 'MAP_ID_REQUIRED' },
      { mapId: 'unknown-map', code: 'MAP_NOT_SELECTABLE' },
      { mapId: 'large-battlefield', code: 'MAP_NOT_SELECTABLE' },
      { mapId: 'large-trap-arena', code: 'MAP_NOT_SELECTABLE' },
      { mapId: '../large-hole-arena', code: 'MAP_NOT_SELECTABLE' },
    ]) {
      const rejected = JSON.parse(await handleMobileServerRequest('POST', '/api/lobby', {
        name: 'Rejected room',
        hostId: 'rejected-host',
        playerName: 'Host',
        mapId,
      }))
      expect(rejected).toMatchObject({ _status: 400, code })
    }

    const afterInvalid = JSON.parse(await handleMobileServerRequest('GET', '/api/lobby', {}))
    expect(afterInvalid.rooms).toHaveLength(initialCount + selectableMapIds.length)
  })
  it.each(selectableMapIds)('starts an Android local room on %s with legacy reroll deployment', async mapId => {
    const hostId = `local-host-${mapId}`
    const guestId = `local-guest-${mapId}`
    const created = JSON.parse(await handleMobileServerRequest('POST', '/api/lobby', {
      name: `Local deployment ${mapId}`,
      hostId,
      playerName: 'Host',
      mapId,
    }))
    expect(created).toMatchObject({ _status: 201, mapId })

    const hostJoin = JSON.parse(await handleMobileServerRequest('POST', `/api/rooms/${created.id}/actions`, {
      action: 'join',
      playerId: hostId,
      playerName: 'Host',
      alignment: 'light',
      mapId: 'large-battlefield',
    }))
    expect(hostJoin).toMatchObject({ _status: 200, mapId })
    expect(hostJoin.players.find((player: { id: string }) => player.id === hostId).alignment).toBe('light')


    const joined = JSON.parse(await handleMobileServerRequest('POST', `/api/rooms/${created.id}/actions`, {
      action: 'join',
      playerId: guestId,
      playerName: 'Guest',
      alignment: 'dark',
      mapId: 'large-hole-arena',
    }))
    expect(joined._status).toBe(200)
    expect(joined.mapId).toBe(mapId)

    const host = joined.players.find((player: { id: string }) => player.id === hostId)
    const guest = joined.players.find((player: { id: string }) => player.id === guestId)
    expect([host?.faction, guest?.faction].sort()).toEqual(['blue', 'red'])
    expect(host?.alignment).toBe('light')
    expect(guest?.alignment).toBe('dark')

    const claimed = JSON.parse(await handleMobileServerRequest('POST', `/api/rooms/${created.id}/actions`, {
      action: 'claim-faction',
      playerId: hostId,
      playerName: 'Host',
      alignment: 'light',
      mapId: 'open-expanse',
    }))
    expect(claimed).toMatchObject({ _status: 200, alignment: 'light', room: { mapId } })

    const lobby = JSON.parse(await handleMobileServerRequest('GET', '/api/lobby', {}))
    const listedRoom = lobby.rooms.find((room: { id: string }) => room.id === created.id)
    expect(listedRoom.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: hostId, alignment: 'light' }),
      expect.objectContaining({ id: guestId, alignment: 'dark' }),
    ]))

    const hostSelection = JSON.parse(await handleMobileServerRequest('POST', `/api/rooms/${created.id}/actions`, {
      action: 'select-pieces',
      playerId: hostId,
      alignment: 'light',
      mapId: 'large-battlefield',
      pieces: lightRoster.map(templateId => ({ templateId, faction: host.faction })),
    }))
    expect(hostSelection._status).toBe(200)

    const guestSelection = JSON.parse(await handleMobileServerRequest('POST', `/api/rooms/${created.id}/actions`, {
      playerId: guestId,
      action: 'select-pieces',
      pieces: darkRoster.map(templateId => ({ templateId, faction: guest.faction })),
      alignment: 'dark',
      mapId: 'narrow-corridors',
    }))
    expect(guestSelection._status).toBe(200)

    const battle = JSON.parse(await handleMobileServerRequest('GET', `/api/rooms/${created.id}/battle?since=-1`, {})) as {
      _status: number
      total: number
      actions: Array<{
        type: string
        randomStreams?: Array<{ name: string; startCursor: number; endCursor: number }>
        payload: {
          map: {
            id: string
            tiles: Array<{ x: number; y: number; props: { type: string; walkable: boolean } }>
          }
          pieces: Array<{
            isCore?: boolean
            ownerPlayerId: string
            x: number | null
            y: number | null
          }>
          deployment: {
            mode?: string
            status: string
            startedAt: number
            deadlineAt: number
            locks: Record<string, { locked: boolean }>
            activePlayerId?: string
            reserveCounts?: Record<string, number>
            offerPieceIds?: string[]
            offerPieces?: Array<{ instanceId: string }>
            legalPositions?: Array<{ x: number; y: number }>
          }
          turn: { phase: string }
          gameStartFired?: boolean
          extensions: { playerAlignments: Record<string, 'light' | 'dark'> }
        }
      }>
    }
    expect(battle).toMatchObject({ _status: 200, total: 1 })
    expect(battle.actions).toHaveLength(1)

    const initAction = battle.actions[0]
    const state = initAction.payload
    const cores = state.pieces.filter(piece => piece.isCore)
    const ordinaryFloors = new Set(
      state.map.tiles
        .filter(tile => tile.props.walkable && tile.props.type === 'floor')
        .map(tile => `${tile.x},${tile.y}`),
    )
    expect(initAction.type).toBe('init')
    expect(initAction.randomStreams).toContainEqual({
      name: 'deployment',
      startCursor: 0,
      endCursor: 16,
    })
    expect((initAction.randomStreams ?? []).some(
      stream => stream.name.startsWith('progressive-deployment/'),
    )).toBe(false)
    expect(state.map.id).toBe(mapId)
    expect(cores).toHaveLength(16)
    expect(new Set(cores.map(piece => `${piece.x},${piece.y}`)).size).toBe(16)
    expect(cores.every(piece => ordinaryFloors.has(`${piece.x},${piece.y}`))).toBe(true)
    expect(state.deployment).toMatchObject({
      mode: 'legacy-reroll-v1',
      status: 'awaiting-locks',
      locks: {
        [hostId]: { locked: false },
        [guestId]: { locked: false },
      },
    })
    expect(state.deployment.deadlineAt - state.deployment.startedAt).toBe(DEPLOYMENT_DURATION_MS)
    expect(state.deployment).not.toHaveProperty('activePlayerId')
    expect(state.deployment).not.toHaveProperty('reserves')
    expect(state.deployment).not.toHaveProperty('reserveCounts')
    expect(state.deployment).not.toHaveProperty('offerPieceIds')
    expect(state.deployment).not.toHaveProperty('offerPieces')
    expect(state.turn.phase).toBe('start')
    expect(state.gameStartFired).toBeFalsy()
    expect(state.extensions.playerAlignments).toEqual({ [hostId]: 'light', [guestId]: 'dark' })
  })

  it('rejects malformed Android rosters before room, battle, version, or RNG mutation', async () => {
    const hostId = 'invalid-roster-host'
    const guestId = 'invalid-roster-guest'
    const created = JSON.parse(await handleMobileServerRequest('POST', '/api/lobby', {
      name: 'Invalid roster room',
      hostId,
      playerName: 'Host',
      mapId: 'winding-pass',
    }))
    await handleMobileServerRequest('POST', '/api/rooms/' + created.id + '/actions', {
      action: 'join',
      playerId: hostId,
      playerName: 'Host',
      alignment: 'light',
    })
    await handleMobileServerRequest('POST', '/api/rooms/' + created.id + '/actions', {
      action: 'join',
      playerId: guestId,
      playerName: 'Guest',
      alignment: 'dark',
    })

    const before = JSON.parse(await handleMobileServerRequest('GET', '/api/rooms/' + created.id, {}))
    const invalidRosters = [
      lightRoster.slice(0, 1),
      lightRoster.slice(0, 7),
      [...lightRoster, 'jaina'],
      [...lightRoster.slice(0, 7), lightRoster[0]],
    ]
    const randomSpy = vi.spyOn(Math, 'random')
    try {
      for (const roster of invalidRosters) {
        const response = JSON.parse(await handleMobileServerRequest(
          'POST',
          '/api/rooms/' + created.id + '/actions',
          {
            action: 'select-pieces',
            playerId: hostId,
            alignment: 'light',
            pieces: roster.map(templateId => ({ templateId, faction: 'good' })),
          },
        ))
        const after = JSON.parse(await handleMobileServerRequest('GET', '/api/rooms/' + created.id, {}))
        const battle = JSON.parse(await handleMobileServerRequest(
          'GET',
          '/api/rooms/' + created.id + '/battle?since=-1',
          {},
        ))

        expect(response).toMatchObject({
          _status: 400,
          error: expect.stringContaining('Exactly 8 unique valid pieces'),
        })
        expect(after).toEqual(before)
        expect(battle).toMatchObject({ _status: 400, error: 'Battle not started' })
      }
      expect(randomSpy).not.toHaveBeenCalled()
    } finally {
      randomSpy.mockRestore()
    }
  })


  it('rejects duplicate seats instead of allowing a client to bypass red/blue order', async () => {
    const duplicateSeats = players.map(player => ({ ...player, faction: 'red' as const }))
    const request = new NextRequest('http://localhost/api/relay-battle-init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapId: 'large-hole-arena', players: duplicateSeats }),
    })

    const response = await POST(request)
    const body = await response.json()
    const mobileBody = JSON.parse(await handleRelayBattleInit({ mapId: 'large-hole-arena', players: duplicateSeats }))

    expect(response.status).toBe(400)
    expect(body.error).toContain('exactly one red and one blue')
    expect(mobileBody).toMatchObject({
      _status: 400,
      error: expect.stringContaining('exactly one red and one blue'),
    })
  })

  it('leaves deployment timeout settlement to the authoritative room coordinator', () => {
    const page = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const coordinator = readFileSync(resolve(process.cwd(), 'lib/game/room-battle-actions.ts'), 'utf8')

    expect(coordinator).toContain("state.deployment?.status === 'awaiting-locks'")
    expect(coordinator).toContain("type: 'deploymentTimeout'")
    expect(coordinator).toContain("kind: expired ? 'expired' : 'applied'")
    expect(page).not.toContain('function runRelayAuthorityAction(action)')
    expect(page).not.toContain('scheduleRelayDeploymentTimeout')
    expect(page).not.toContain('publishRelayAuthorityResult')
  })

  it('submits signed Relay commands and ignores legacy host-authority messages', () => {
    const page = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const wsClient = readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8')

    expect(page).toContain('var relayActionAuth = await createBattleActionAuth(action)')
    expect(page).toContain('RvBWs.send(battleAuthorityCommandMessage(action, relayActionAuth')
    expect(page).toContain('expectedAuthorityVersion: Number.isSafeInteger(latestAuthorityVersion)')
    expect(page).toContain('已忽略旧 Relay 客户端权威动作')
    expect(page).toContain('已忽略非权威 Relay 恢复状态')
    expect(page).not.toContain('postLocalRelayInitialization')
    expect(page).not.toContain('verifyRelayBattleActionAuth')
    expect(page).not.toContain('relayAuthorityState')
    expect(wsClient).toContain("type: 'battle-subscribe'")
    expect(wsClient).toContain("localStorage.getItem('rvb_game_profile_identity')")
    expect(wsClient).toContain('profileIdentity: profileIdentity')
    expect(wsClient).toContain('signature: await window.RvBIdentity.sign(payload)')
  })
})

describe('standalone Relay map persistence', () => {
  const selectableMapIds = [
    'large-hole-arena',
    'open-expanse',
    'winding-pass',
    'narrow-corridors',
  ] as const

  it('accepts only the exact four authoritative map IDs', () => {
    expect(STANDALONE_SELECTABLE_MAP_IDS).toEqual(selectableMapIds)
    expect(STANDALONE_SELECTABLE_MAP_IDS).toEqual(SELECTABLE_MAP_IDS)
    for (const mapId of selectableMapIds) {
      expect(validateStandaloneMapId(mapId)).toEqual({ ok: true, mapId })
    }
    expect(validateStandaloneMapId(undefined)).toMatchObject({ ok: false, code: 'MAP_ID_REQUIRED' })
    for (const mapId of ['large-battlefield', 'large-trap-arena', 'unknown-map', '../large-hole-arena', ' large-hole-arena']) {
      expect(validateStandaloneMapId(mapId)).toMatchObject({ ok: false, code: 'MAP_NOT_SELECTABLE' })
    }
  })
  it('exposes the stable four-map catalog through the standalone Relay entry', () => {
    expect(STANDALONE_SELECTABLE_MAP_CATALOG).toEqual([
      { id: 'large-hole-arena', name: '大型洞穴' },
      { id: 'open-expanse', name: '开阔原野' },
      { id: 'winding-pass', name: '回风曲径' },
      { id: 'narrow-corridors', name: '狭廊要道' },
    ])
    const entry = readFileSync(resolve(process.cwd(), 'relay-server/src/index.ts'), 'utf8')
    expect(entry).toContain("app.get('/api/maps'")
    expect(entry).toContain('maps: STANDALONE_SELECTABLE_MAP_CATALOG')
  })

  it('validates before room writes and persists nullable legacy map IDs', () => {
    const lobby = readFileSync(resolve(process.cwd(), 'relay-server/src/routes/lobby.ts'), 'utf8')
    const createRoute = lobby.slice(lobby.indexOf("lobbyRouter.post('/'"), lobby.indexOf('await store.persistRoom(room)') + 'await store.persistRoom(room)'.length)
    const store = readFileSync(resolve(process.cwd(), 'relay-server/src/store.ts'), 'utf8')
    const schema = readFileSync(resolve(process.cwd(), 'relay-server/prisma/schema.prisma'), 'utf8')
    const baseline = readFileSync(resolve(process.cwd(), 'relay-server/prisma/migrations/20260827100000_relay_schema_baseline/migration.sql'), 'utf8')
    const runbook = readFileSync(resolve(process.cwd(), 'relay-server/prisma/migrations/README.md'), 'utf8')
    const migration = readFileSync(
      resolve(process.cwd(), 'relay-server/prisma/migrations/20260827102000_add_room_map_id/migration.sql'),
      'utf8',
    )

    expect(createRoute.indexOf('validateStandaloneMapId(body.mapId)')).toBeLessThan(createRoute.indexOf('await store.persistRoom(room)'))
    expect(createRoute).toContain('mapId: mapSelection.mapId')
    expect(store.match(/mapId: room\.mapId \?\? null/g)?.length).toBeGreaterThanOrEqual(2)
    expect(store).toContain('mapId: r.mapId ?? undefined')
    expect(schema).toMatch(/mapId\s+String\?/)
    expect(migration).toContain('ADD COLUMN "mapId" TEXT')
    expect(migration).not.toMatch(/UPDATE|DEFAULT|NOT NULL/)
    expect(baseline.match(/CREATE TABLE/g)).toHaveLength(3)
    expect(baseline).toContain('CREATE TABLE "Room"')
    expect(baseline).toContain('CREATE TABLE "LeaderboardPlayer"')
    expect(baseline).toContain('CREATE TABLE "BattleRecord"')
    expect(baseline).not.toContain('"mapId"')
    expect(runbook).toContain('--applied 20260827100000_relay_schema_baseline')
    expect(runbook).toContain('bun run db:migrate')
  })

  it('preflights persisted Android map IDs before every pre-battle mutation', () => {
    const mobile = readFileSync(resolve(process.cwd(), 'mobile-server/mobile-server-entry.ts'), 'utf8')
    const roomPost = mobile.slice(mobile.indexOf('async function handleRoomPost'), mobile.indexOf('// ── Shared game-start helper'))
    const claimFaction = mobile.slice(mobile.indexOf('function handleClaimFaction'), mobile.indexOf('async function handleSelectPieces'))
    const selectPieces = mobile.slice(mobile.indexOf('async function handleSelectPieces'), mobile.indexOf('// GET /api/rooms/:id/battle'))
    const preflight = 'const mapSelection = readSelectableMapId(room.mapId)'
    const selectionPreflight = 'const mapSelection = readSelectableMapId(storedRoom.mapId)'

    for (const source of [roomPost, claimFaction]) {
      expect(source).toContain(preflight)
    }
    expect(selectPieces).toContain(selectionPreflight)
    expect(roomPost.indexOf(preflight)).toBeLessThan(roomPost.indexOf('room.version++'))
    expect(roomPost.indexOf(preflight)).toBeLessThan(roomPost.indexOf('player.ready = !player.ready'))
    expect(claimFaction.indexOf(preflight)).toBeLessThan(claimFaction.indexOf('room.players.push(player)'))
    expect(claimFaction.indexOf(preflight)).toBeLessThan(claimFaction.indexOf('_broadcastRoomUpdate(room)'))
    expect(selectPieces.indexOf(selectionPreflight)).toBeLessThan(selectPieces.indexOf('player.selectedPieces = pieces'))
    expect(roomPost.indexOf(preflight)).toBeLessThan(roomPost.indexOf('_broadcastRoomUpdate(room)'))
  })

})
