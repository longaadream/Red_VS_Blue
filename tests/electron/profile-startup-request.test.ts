import { readFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { expect, it } from 'vitest'
import { StartupWatchdog } from '../../electron-client/startup-watchdog'

it('rejects a partially returned startup response and cleans up progress listeners', async () => {
  const source = readFileSync(new URL('../../electron-client/main.ts', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('function profileApiRequest<'), source.indexOf('function decodeProfileArchive('))
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"state":')
    setTimeout(() => res.destroy(), 10)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const child = new EventEmitter()
  const context = vm.createContext({ http: { request }, randomBytes, Buffer, Error, JSON,
    actualLocalPort: (server.address() as {port:number}).port, PROFILE_ADMIN_KEY:'test',
    app:{isPackaged:true}, serverProcess:child, StartupWatchdog, startupCancelled:false,
    localAuthorityNotice:null, reportStartupProgress:()=>{}, LOCAL_GAME_OPEN_CANCELLED:'cancelled',
    setInterval, clearInterval,
  })
  vm.runInContext(transformSync(fn, { loader:'ts' }).code, context)
  try {
    await expect(vm.runInContext("profileApiRequest('/api/content-profile', {startup:true})", context)).rejects.toThrow(/ABORTED|aborted/)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(child.listenerCount('message')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 5000)
