import { readFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { expect, it } from 'vitest'
import { StartupWatchdog } from '../../electron-client/startup-watchdog'

it.each(['exit', 'failure'])('ends startup immediately on %s and releases listeners', async kind => {
  const source = readFileSync(new URL('../../electron-client/main.ts', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('function waitForGameAuthorityReady('), source.indexOf('function findColyseusEntry('))
  const server = createServer(() => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const child = new EventEmitter()
  const context = vm.createContext({ http:{get}, Error, StartupWatchdog,
    gameServerProcess:child, startupCancelled:false, localAuthorityNotice:null,
    appendAuthorityDiagnostic:()=>{}, reportStartupProgress:()=>{},
    setInterval, clearInterval, setTimeout, clearTimeout,
  })
  vm.runInContext(transformSync(fn, {loader:'ts'}).code, context)
  const promise = vm.runInContext(`waitForGameAuthorityReady(${(server.address() as {port:number}).port}, 900000)`, context)
  setTimeout(() => {
    if (kind === 'exit') child.emit('exit', 9)
    else child.emit('message', {type:'rvb:authority:startup-failed', error:'PROFILE_HASH_MISMATCH'})
  }, 10)
  try {
    await expect(promise).rejects.toThrow(kind === 'exit' ? '已退出' : 'PROFILE_HASH_MISMATCH')
    expect(child.listenerCount('message')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 5000)
