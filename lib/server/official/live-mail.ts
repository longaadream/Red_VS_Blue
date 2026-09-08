import { createSmtpMailer, type SmtpSettings } from './mail'
import type { MailSender } from './accounts'

/** Keep in-flight messages on their original transport; new messages see the verified replacement. */
export function createLiveMailer(initial: SmtpSettings, persist: (settings: SmtpSettings) => void, factory = createSmtpMailer) {
  let settings = initial, current = factory(settings)
  const transports = new Set([current])
  const inFlight = new Map<typeof current, number>()
  const retire = (mail: typeof current) => { if (mail !== current && !inFlight.get(mail)) { mail.close(); transports.delete(mail) } }
  const send: MailSender = async (...args) => {
    const mail = current; inFlight.set(mail, (inFlight.get(mail) || 0) + 1)
    try { await mail.send(...args) } finally { inFlight.set(mail, inFlight.get(mail)! - 1); retire(mail) }
  }
  return {
    send, status: () => current.status(), verify: () => current.verify(),
    settings: () => ({ host: settings.host, port: settings.port, user: settings.user, from: settings.from }),
    async replace(input: SmtpSettings) {
      const next = { ...input, password: input.password || settings.password }
      const replacement = factory(next)
      try { await replacement.verify(); persist(next) } catch { replacement.close(); throw new Error('SMTP验证或本机保存失败，已保留原配置') }
      const previous = current; settings = next; current = replacement; transports.add(current); retire(previous)
    },
    close() { for (const mail of transports) mail.close(); transports.clear() },
  }
}
