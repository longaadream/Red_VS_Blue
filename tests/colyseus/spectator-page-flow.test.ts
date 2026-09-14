import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { createContext, runInContext } from 'node:vm'
import { Client } from '@colyseus/sdk'
import { expect, it, vi } from 'vitest'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import { FakeAuthorityRepository } from './fake-authority-repository'

it('the production lobby spectator preflight and battle page connect to the same live battle', async () => {
  const socket = createServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = (socket.address() as AddressInfo).port
  await new Promise<void>(resolve => socket.close(() => resolve()))
  const server = createColyseusBattleServer({ repository: new FakeAuthorityRepository() })
  await server.server.listen(port, '127.0.0.1')
  const url = `http://127.0.0.1:${port}`
  const profileIdentity = getServerGameProfileIdentityV1()
  const sdk = new Client(url)
  const host = await sdk.create('battle', { product: true, visibility: 'public', playerId: 'host', alignment: 'light', profileIdentity })
  const guest = await sdk.joinById(host.roomId, { playerId: 'guest', alignment: 'dark', profileIdentity })
  const session = new Map<string, string>()
  const messages: Array<{ type: string; state?: { players: Array<{ hand: Array<{ cardId: string }> }> } }> = []
  const errors: unknown[] = []
  const window = {
    location: { search: '' },
    Colyseus: { Client },
    sessionStorage: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) },
    RvBUtils: { getServerUrl: () => url },
    RvBIdentity: { getIdentity: () => ({ id: 'viewer', displayName: 'Viewer' }) },
  }
  const context = createContext({ window, localStorage: { getItem: () => JSON.stringify(profileIdentity) }, URL, URLSearchParams, AbortController, fetch, setTimeout, clearTimeout, setInterval, clearInterval, console })
  runInContext(readFileSync('data/pages/js/colyseus-client.js', 'utf8'), context)
  const client = runInContext('window.RvBColyseus', context)
  try {
    for (const [room, playerId, alignment, faction] of [[host, 'host', 'light', 'good'], [guest, 'guest', 'dark', 'evil']] as const) {
      const pieces = getDemoPieceIds().map(id => getPieceById(id)!).filter(piece => piece.faction === faction).slice(0, 8).map(piece => ({ templateId: piece.id }))
      await room.request('roomRpc', { method: 'rooms.action', data: { action: 'select-pieces', playerId, alignment, pieces, profileIdentity } })
    }
    const result = await client.requestAt(url, 'rooms.spectate', { roomId: host.roomId, spectatorId: 'viewer', profileIdentity })
    expect(result.id).toBe(host.roomId)
    window.location.search = '?mode=spectate'
    client.on('message', (message: typeof messages[number]) => messages.push(message))
    client.on('error', (error: unknown) => errors.push(error))
    client.connect(host.roomId, 'viewer')
    await vi.waitFor(() => {
      expect(errors).toEqual([])
      expect(messages.some(message => message.type === 'stateUpdate')).toBe(true)
    }, { timeout: 8000 })
    const state = messages.find(message => message.type === 'stateUpdate')!.state!
    expect(state.players.every(player => player.hand.every(card => card.cardId === 'hidden'))).toBe(true)
  } finally {
    client.disconnect()
    await host.leave(); await guest.leave()
    await server.server.gracefullyShutdown(false)
  }
}, 20000)
