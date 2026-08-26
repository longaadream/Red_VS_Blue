import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '../../app/api/relay-battle-init/route'
import { DEPLOYMENT_DURATION_MS } from '../../lib/game/deployment'
import { handleRelayBattleInit } from '../../mobile-server/mobile-server-entry'

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

describe('legacy relay deployment initialization', () => {
  const players = [
    { id: 'alice', faction: 'red' as const, pieces: lightRoster.map(templateId => ({ templateId })) },
    { id: 'bob', faction: 'blue' as const, pieces: darkRoster.map(templateId => ({ templateId })) },
  ]

  it('uses the fixed Demo map and starts the same public 45-second deployment phase', async () => {
    const request = new NextRequest('http://localhost/api/relay-battle-init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mapId: 'large-battlefield',
        players,
      }),
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.state.map.id).toBe('large-hole-arena')
    expect(body.state.pieces.filter((piece: { isCore?: boolean }) => piece.isCore)).toHaveLength(16)
    expect(body.state.deployment).toMatchObject({
      status: 'awaiting-locks',
      choices: {},
      revision: 0,
    })
    expect(body.state.deployment.deadlineAt - body.state.deployment.startedAt).toBe(DEPLOYMENT_DURATION_MS)
    expect(body.state.turn.currentPlayerId).toBe('alice')
    expect(body.state.gameStartFired).toBeFalsy()
    expect(body.authorityVersion).toBe(1)
    expect(body.state.extensions.debugBattle.actionLog[0].deployment.authorityVersion).toBe(1)
    expect(body.stateHash).toEqual(expect.any(String))
  })

  it('starts Android Relay with the same fixed map, deadline, locks, and authority envelope', async () => {
    const body = JSON.parse(await handleRelayBattleInit({
      mapId: 'large-battlefield',
      players,
    }))

    expect(body._status).toBe(200)
    expect(body.authorityVersion).toBe(1)
    expect(body.stateHash).toEqual(expect.any(String))
    expect(body.state.map.id).toBe('large-hole-arena')
    expect(body.state.deployment).toMatchObject({
      status: 'awaiting-locks',
      choices: {},
      locks: {
        alice: { locked: false },
        bob: { locked: false },
      },
      revision: 0,
    })
    expect(body.state.deployment.deadlineAt - body.state.deployment.startedAt).toBe(DEPLOYMENT_DURATION_MS)
    expect(body.state.turn.currentPlayerId).toBe('alice')
    expect(body.state.extensions.debugBattle.actionLog[0].deployment.authorityVersion).toBe(1)
  })

  it('rejects duplicate seats instead of allowing a client to bypass red/blue order', async () => {
    const duplicateSeats = players.map(player => ({ ...player, faction: 'red' as const }))
    const request = new NextRequest('http://localhost/api/relay-battle-init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ players: duplicateSeats }),
    })

    const response = await POST(request)
    const body = await response.json()
    const mobileBody = JSON.parse(await handleRelayBattleInit({ players: duplicateSeats }))

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
    const androidWsClient = readFileSync(resolve(process.cwd(), 'android-client/www/js/ws-client.js'), 'utf8')
    const serverUtils = readFileSync(resolve(process.cwd(), 'data/pages/js/server-utils.js'), 'utf8')
    const androidServerUtils = readFileSync(resolve(process.cwd(), 'android-client/www/js/server-utils.js'), 'utf8')

    expect(page).toContain('var relayActionAuth = await createBattleActionAuth(action)')
    expect(page).toContain('RvBWs.send(battleAuthorityCommandMessage(action, relayActionAuth')
    expect(page).toContain('expectedAuthorityVersion: Number.isSafeInteger(latestAuthorityVersion)')
    expect(page).toContain('已忽略旧 Relay 客户端权威动作')
    expect(page).toContain('已忽略非权威 Relay 恢复状态')
    expect(page).not.toContain('postLocalRelayInitialization')
    expect(page).not.toContain('verifyRelayBattleActionAuth')
    expect(page).not.toContain('relayAuthorityState')
    expect(wsClient).toContain("type: 'battle-subscribe'")
    expect(wsClient).toContain('signature: await window.RvBIdentity.sign(payload)')
    expect(androidWsClient).toBe(wsClient)
    expect(androidServerUtils).toBe(serverUtils)
  })
})
