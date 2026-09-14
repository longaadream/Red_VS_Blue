import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('pins spectator admission and navigation to the lobby endpoint even when another window changes the saved server', async () => {
  const source = readFileSync('data/pages/lobby.html', 'utf8')
  const start = source.indexOf('    async function spectateRoom(')
  const end = source.indexOf('    async function deleteRoom(', start)
  const target = 'http://26.1.2.3:2567'
  const location = { href: '' }
  const request = vi.fn(async (base: string) => ({ id: 'AbC-room', base }))
  const context = createContext({
    window: { location }, URLSearchParams,
    RvBIdentity: { getIdentity: () => ({ id: 'viewer', displayName: '观众' }) },
    RvBUtils: { getConnectionConfig: () => ({ mode: 'lan', url: target }), getServerUrl: () => 'http://localhost:2567' },
    RvBColyseus: { requestAt: request }, lobbyRequest: request,
    getLocalGameProfileIdentity: async () => ({ schemaVersion: 'test-profile' }),
    formatProfileError: String, alert: vi.fn(),
  })
  runInContext(source.slice(start, end), context)
  await runInContext("spectateRoom('AbC-room')", context)
  const page = new URL(location.href, 'https://client.local/')
  expect(page.searchParams.get('serverUrl')).toBe(target)
  expect(page.searchParams.get('server')).toBe('lan')
  expect(page.searchParams.get('roomId')).toBe('AbC-room')
  expect(page.searchParams.get('mode')).toBe('spectate')
  expect(request.mock.calls[0][0]).toBe(target)
})
