import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const playerPages = [
  'index.html',
  'lobby.html',
  'room.html',
  'piece-selection.html',
  'battle.html',
]

describe('RED-127 player networking boundary', () => {
  it.each(playerPages)('%s does not call legacy player JSON APIs', page => {
    const source = readFileSync(resolve('data/pages', page), 'utf8')

    expect(source).not.toMatch(/['"`]\/api\/(?:ping|lobby|maps|pieces|skills|cards(?:\/|['"`])|rooms(?:\/|['"`])|admin\/resource-pack)/)
    expect(source).not.toContain('HTTP fallback')
  })

  it('uses the same WebSocket room RPC path for LAN and relay', () => {
    const lobby = readFileSync(resolve('data/pages/lobby.html'), 'utf8')
    const room = readFileSync(resolve('data/pages/room.html'), 'utf8')
    const selection = readFileSync(resolve('data/pages/piece-selection.html'), 'utf8')

    expect(lobby).not.toContain('relayJson(')
    expect(room).not.toMatch(/finally\s*\{[\s\S]*?readyBtn'\)\.disabled = false/)
    expect(room).not.toContain('roomJson(')
    expect(selection).not.toContain('falling back to HTTP')
    expect(room).not.toMatch(/if \(shouldUseRelayMode\(\)\) \{[\s\S]*?btn\.disabled = true/)
  })

  it('uses WebSocket health and content identity for connection checks', () => {
    const index = readFileSync(resolve('data/pages/index.html'), 'utf8')
    const discovery = readFileSync(resolve('data/pages/js/lan-discover.js'), 'utf8')
    const websocket = readFileSync(resolve('data/pages/js/ws-client.js'), 'utf8')
    expect(index).toContain('RvBWs.requestCatalogIdentityAt')
    expect(websocket).toContain("requestAt(baseUrl, 'catalog.identity', {}, timeoutMs)")
    expect(discovery).not.toContain('fetch(')
  })
})

describe('RED-116 Electron lobby profile bridge', () => {
  it('pins the local Profile Identity before navigating to the server lobby', () => {
    const index = readFileSync(resolve('data/pages/index.html'), 'utf8')
    const start = index.indexOf('async function checkProfileAndGo')
    const end = index.indexOf('function updatePackBadge', start)
    const body = index.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(body).toContain('await getLocalGameProfileIdentity(serverUrl)')
    expect(body.indexOf('await getLocalGameProfileIdentity(serverUrl)'))
      .toBeLessThan(body.indexOf('goLobby(mode, serverUrl)'))
    expect(body).toContain("RvBWs.requestCatalogIdentityAt(serverUrl, 'remote-server')")
    expect(body).toContain("console.warn('[profile] remote catalog identity preflight failed', error)")
  })

  it('reads a validated stored Profile Identity before using protected Electron IPC', () => {
    const lobby = readFileSync(resolve('data/pages/lobby.html'), 'utf8')
    const readerStart = lobby.indexOf('function readStoredGameProfileIdentity')
    const readerEnd = lobby.indexOf('async function getLocalGameProfileIdentity', readerStart)
    const reader = lobby.slice(readerStart, readerEnd)
    const getterStart = readerEnd
    const getterEnd = lobby.indexOf('function summarizeGameProfileIdentity', getterStart)
    const getter = lobby.slice(getterStart, getterEnd)

    expect(readerStart).toBeGreaterThanOrEqual(0)
    expect(reader).toContain("localStorage.getItem('rvb_game_profile_identity')")
    expect(reader).toContain('isGameProfileIdentity')
    expect(getter).toContain('readStoredGameProfileIdentity()')
    expect(getter.indexOf('readStoredGameProfileIdentity()'))
      .toBeLessThan(getter.indexOf('window.electronAPI'))
  })

  it('resolves the client local runtime through trusted game IPC', () => {
    const websocket = readFileSync(resolve('data/pages/js/ws-client.js'), 'utf8')
    expect(websocket).toContain("requestAt(baseUrl, 'catalog.identity', {}, timeoutMs)")

    for (const page of ['index.html', 'lobby.html']) {
      const source = readFileSync(resolve('data/pages', page), 'utf8')
      const start = source.indexOf('async function getLocalGameProfileIdentity')
      const end = source.indexOf(
        page === 'index.html' ? 'async function checkProfileAndGo' : 'function summarizeGameProfileIdentity',
        start,
      )
      const getter = source.slice(start, end)

      expect(getter).toContain('window.electronAPI.getMode')
      expect(getter).toContain('mode.localUrl')
      expect(getter).toContain('RvBWs.requestCatalogIdentityAt')
      expect(getter).toContain("'local-profile-runtime'")
      expect(getter).not.toContain('getResourcePackStatus')
      expect(getter.indexOf('mode.localUrl'))
        .toBeLessThan(getter.indexOf('RvBWs.requestCatalogIdentityAt'))
    }
  })
})
