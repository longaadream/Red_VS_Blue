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

  it('commits timeout before any Relay player command received at or after the deadline', () => {
    const page = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')

    expect(page).toContain('function runRelayAuthorityAction(action)')
    expect(page).toContain("deployment.status === 'awaiting-locks' && now >= Number(deployment.deadlineAt || 0)")
    expect(page).toContain("expired.code = 'DEPLOYMENT_EXPIRED'")
    expect(page.match(/runRelayAuthorityAction\(/g)).toHaveLength(3)
    expect(page).not.toContain('runDeterministicAuthorityAction(relayAuthorityState || G, msg.action)')
    expect(page).not.toContain('runDeterministicAuthorityAction(relayAuthorityState || G, action)')
  })

  it('initializes the Relay host locally and forwards signed commands plus version metadata', () => {
    const page = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const relayHandler = readFileSync(resolve(process.cwd(), 'relay-server/src/ws/handler.ts'), 'utf8')
    const wsClient = readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8')
    const androidWsClient = readFileSync(resolve(process.cwd(), 'android-client/www/js/ws-client.js'), 'utf8')

    expect(page).toContain("postLocalRelayInitialization({ players: players })")
    expect(page).toContain("RvBUtils.mobileServerFetch('/api/relay-battle-init', options)")
    expect(page).toContain('await verifyRelayBattleActionAuth(msg)')
    expect(page).toContain('GameEngine.stampPendingDeploymentAuthorityVersion(relayAuthorityState, relaySeq)')
    expect(wsClient).toContain("type: 'battle-subscribe'")
    expect(wsClient).toContain('signature: await window.RvBIdentity.sign(payload)')
    expect(androidWsClient).toBe(wsClient)
    expect(relayHandler).toContain('auth: msg.auth')
    expect(relayHandler).toContain('await verifyBattleSubscribeAuth(msg')
    expect(relayHandler).toContain('authorityVersion: msg.authorityVersion')
    expect(relayHandler).toContain("type: 'hostResume'")
  })
})
