import { expect, it, vi } from 'vitest'
import { createLiveMailer } from '@/lib/server/official/live-mail'
import type { createSmtpMailer } from '@/lib/server/official/mail'

it('verifies and persists before swapping SMTP; retains old transport until its message completes', async () => {
  let release!: () => void
  const sent = new Promise<void>(resolve => { release = resolve })
  const original = { send: vi.fn(() => sent), verify: vi.fn(async () => true), close: vi.fn(), status: () => ({ host: 'old' }) }
  const replacement = { ...original, send: vi.fn(async () => {}), close: vi.fn(), verify: vi.fn(async () => true), status: () => ({ host: 'new' }) }
  const persist = vi.fn(), factory = vi.fn().mockReturnValueOnce(original).mockReturnValue(replacement)
  const settings = { host: 'smtp.test', port: 465, user: 'u', password: 'never-output', from: 'a@test.example' }
  const mail = createLiveMailer(settings, persist, factory as unknown as typeof createSmtpMailer)
  const sending = mail.send('x@test.example', 'verify', 'code')
  await mail.replace({ ...settings, password: '', host: 'new.test' })
  expect(persist.mock.calls[0][0].password).toBe(settings.password)
  expect(original.close).not.toHaveBeenCalled()
  release(); await sending; expect(original.close).toHaveBeenCalledOnce()
  expect(JSON.stringify(mail.settings())).not.toContain('never-output')
  replacement.verify.mockRejectedValueOnce(new Error('secret-provider-error'))
  await expect(mail.replace(settings)).rejects.toThrow('保留原配置')
  expect(persist).toHaveBeenCalledTimes(1)
})
