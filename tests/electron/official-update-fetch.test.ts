import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { net, session } from 'electron'

vi.mock('electron', () => ({ net: { request: vi.fn() }, session: { fromPartition: vi.fn(() => ({ setProxy: vi.fn(async () => {}) })) } }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubEnv('RVB_UPDATE_PROXY', '') })
async function fixture() {
  const { officialUpdateFetch } = await import('../../electron-client/official-update-fetch')
  const request = Object.assign(new EventEmitter(), { abort: vi.fn(), setHeader: vi.fn(), end: vi.fn() })
  vi.mocked(net.request).mockReturnValue(request as unknown as Electron.ClientRequest)
  const pending = officialUpdateFetch('https://api.github.com/example', {})
  await vi.waitFor(() => expect(net.request).toHaveBeenCalled())
  return { request, pending }
}
it.each([204, 205, 304])('handles an HTTP %s response as a bounded empty body without a main-process exception', async status => {
  const f = await fixture()
  expect(() => f.request.emit('response', Object.assign(new EventEmitter(), { statusCode: status, headers: {} }))).not.toThrow()
  const response = await f.pending
  expect(response.status).toBe(status)
  expect(response.body).toBeNull()
})
it('rejects malformed response headers inside the callback boundary', async () => {
  const f = await fixture()
  const result = expect(f.pending).rejects.toThrow()
  expect(() => f.request.emit('response', { statusCode: 200, headers: { 'invalid\nheader': 'x' } })).not.toThrow()
  await result
})
it('cancels the network body safely even if data and end arrive afterward', async () => {
  const f = await fixture()
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} })
  f.request.emit('response', response)
  await (await f.pending).body!.cancel()
  expect(() => { response.emit('data', Buffer.from('late')); response.emit('end'); response.emit('error', new Error('late')) }).not.toThrow()
  expect(f.request.abort).toHaveBeenCalled()
})
it('exposes redirects for core validation and ignores the cancellation error', async () => {
  const f = await fixture()
  f.request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/file')
  f.request.emit('error', new Error('Redirect cancelled'))
  expect((await f.pending).headers.get('location')).toContain('release-assets.githubusercontent.com')
})

it('uses an isolated system-proxy session instead of the game direct session', async () => {
  const f = await fixture()
  const isolated = vi.mocked(session.fromPartition).mock.results[0].value
  expect(session.fromPartition).toHaveBeenCalledWith('electron-updater', { cache: false })
  expect(isolated.setProxy).toHaveBeenCalledWith({ mode: 'system' })
  expect(net.request).toHaveBeenCalledWith(expect.objectContaining({ session: isolated, useSessionCookies: false, redirect: 'manual' }))
  f.request.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED'))
  await expect(f.pending).rejects.toThrow('无法解析 GitHub 更新地址')
})
it('uses an explicitly configured launcher proxy without shipping a hardcoded port', async () => {
  vi.stubEnv('RVB_UPDATE_PROXY', 'http://127.0.0.1:18765')
  const f = await fixture()
  const isolated = vi.mocked(session.fromPartition).mock.results[0].value
  expect(isolated.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:18765' })
  f.request.emit('error', new Error('net::ERR_PROXY_CONNECTION_FAILED'))
  await expect(f.pending).rejects.toThrow('无法连接更新代理')
})
