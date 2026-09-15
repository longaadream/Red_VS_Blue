import { afterEach, expect, it, vi } from 'vitest'
import { reportVerificationProgress } from '../../lib/content-pipeline/runtime/verification-progress'
import { withStartupVerification } from '../../lib/content-pipeline/runtime/startup-verification-observer'

afterEach(() => vi.unstubAllGlobals())
it('keeps interleaved requests and unrelated work separate', async () => {
  const send = vi.fn()
  vi.stubGlobal('process', { ...process, connected: true, send })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const request = (id: string) => new Request('http://localhost/api/content-profile', { headers: { 'x-rvb-startup-request': id.repeat(32) } })
  const first = withStartupVerification(request('a'), async () => {
    reportVerificationProgress('profile', 32, 64)
    await gate
    reportVerificationProgress('profile', 64, 64)
  })
  await withStartupVerification(request('b'), async () => { reportVerificationProgress('signature', 0, 0) })
  reportVerificationProgress('profile', 99, 100)
  release()
  await first
  expect(send.mock.calls.map(([p]) => [p.requestId, p.work, p.completed])).toEqual([
    ['a'.repeat(32), 1, 32], ['b'.repeat(32), 1, 0], ['a'.repeat(32), 2, 64],
  ])
})
it('does not leak a request observer after a verification error', async () => {
  const send = vi.fn()
  vi.stubGlobal('process', { ...process, connected: true, send })
  const request = new Request('http://localhost', { headers: { 'x-rvb-startup-request': 'c'.repeat(32) } })
  await expect(withStartupVerification(request, async () => { throw Error('invalid signature') })).rejects.toThrow('invalid signature')
  reportVerificationProgress('profile', 32, 64)
  expect(send).not.toHaveBeenCalled()
})
