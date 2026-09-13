import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createColyseusBattleServer } from '../../lib/server/colyseus/create-colyseus-server'
import { FakeAuthorityRepository } from './fake-authority-repository'

describe('public host discovery metadata', () => {
  it('serves live names and a stable ID on both real HTTP health routes', async () => {
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    let serverName = '同名主机'
    const serverId = 'a'.repeat(32)
    const candidate = createColyseusBattleServer({ repository: new FakeAuthorityRepository(), hostDiscovery: () => ({ serverId, serverName }) })
    await candidate.server.listen(port, '127.0.0.1')
    try {
      for (const name of ['同名主机', '朋友的主机']) {
        serverName = name
        for (const route of ['/api/ping', '/healthz']) {
          const response = await fetch(`http://127.0.0.1:${port}${route}`)
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({ ok: true, protocol: 'rvb-colyseus', serverId, serverName })
        }
      }
    } finally { await candidate.server.gracefullyShutdown(false) }
  })
})
