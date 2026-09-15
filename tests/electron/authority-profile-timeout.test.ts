import { readFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { expect, it } from 'vitest'

const main = readFileSync(new URL('../../electron-client/main.ts', import.meta.url), 'utf8')
const source = main.slice(main.indexOf('function fetchAuthorityProfileIdentity('), main.indexOf('function waitForLocalServerReady('))
const context = vm.createContext({ http: { get }, Buffer, Error, setTimeout, clearTimeout, parseGameProfileIdentity: (value: unknown) => {
  if (!value || typeof value !== 'object') throw Error('INVALID_IDENTITY')
  return value
} })
vm.runInContext(transformSync(source, { loader: 'ts' }).code, context)
const fetchIdentity = vm.runInContext('fetchAuthorityProfileIdentity', context) as (port: number, timeout?: number) => Promise<unknown>

it('allows signed-profile cold verification to finish after the former three-second cutoff', async () => {
  const server = createServer((_req, res) => { setTimeout(() => res.end(JSON.stringify({ profileIdentity: { version: '1.0.1' } })), 3200) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await expect(fetchIdentity((server.address() as {port: number}).port)).resolves.toEqual({version:'1.0.1'}) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 10000)

it('still rejects an unresponsive local service within the request deadline', async () => {
  const server = createServer(() => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await expect(fetchIdentity((server.address() as {port:number}).port, 100)).rejects.toThrow('LOCAL_AUTHORITY_PROFILE_IDENTITY_TIMEOUT') }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 5000)
