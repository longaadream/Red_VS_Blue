import { describe, expect, it, vi } from 'vitest'
import type { AdventureRepository } from '../../lib/server/colyseus/adventure-store'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, existsSync: (path: string) => String(path).replaceAll('\\', '/').endsWith('/pve/roguelike/adventure.json') ? false : original.existsSync(path) }
})
vi.mock('../../lib/pve/roguelike/content', () => {
  throw new Error('PVE content must not be loaded by a PVP-only server')
})

describe('PVP-only resource profiles', () => {
  it('loads the server without PVE content and rejects only adventure creation', async () => {
    const serverModule = await import('../../lib/server/colyseus/create-colyseus-server')
    expect(serverModule.createColyseusBattleServer).toBeTypeOf('function')
    const { createAdventureRoomClass } = await import('../../lib/server/colyseus/adventure-room')
    const AdventureRoom = createAdventureRoomClass({ store: {} as AdventureRepository })
    const room = new AdventureRoom()
    await expect(room.onCreate({ playerId: 'host', profileIdentity: {} })).rejects.toThrow('当前资源包不包含 PVE 冒险')
    room.clock.clear()
  })
})
