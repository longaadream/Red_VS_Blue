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
    expect(index).toContain("'catalog.identity'")
    expect(discovery).not.toContain('fetch(')
  })
})
