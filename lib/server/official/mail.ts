import nodemailer from 'nodemailer'
import type { MailSender } from './accounts'

export type SmtpSettings = { host: string; port: number; user: string; password: string; from: string }
export function createSmtpMailer(settings: SmtpSettings) {
  if (!settings.host || ![465, 587].includes(settings.port) || !settings.user || !settings.password || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(settings.from)) throw new Error('SMTP配置不完整：需要服务器、465或587端口、用户名、授权码及发信地址')
  const transport = nodemailer.createTransport({
    host: settings.host, port: settings.port, secure: settings.port === 465,
    requireTLS: true, auth: { user: settings.user, pass: settings.password },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    disableFileAccess: true, disableUrlAccess: true,
  })
  const send: MailSender = async (to, purpose, code) => {
    await transport.sendMail({ from: { name: 'RED vs BLUE', address: settings.from }, to,
      subject: purpose === 'verify' ? 'RED vs BLUE：验证邮箱' : 'RED vs BLUE：重置密码',
      text: `你的${purpose === 'verify' ? '注册验证' : '密码重置'}代码：\n\n${code}\n\n请复制到游戏中的验证页面。15分钟内有效，只能使用一次。\n如果不是你本人操作，请忽略本邮件。`,
    })
  }
  return { send, verify: () => transport.verify(), close: () => transport.close() }
}
