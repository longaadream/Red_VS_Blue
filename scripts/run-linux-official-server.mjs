import fs from 'node:fs'
import path from 'node:path'
import { createOfficialServer } from '../lib/server/official/server.ts'
import { createSmtpMailer } from '../lib/server/official/mail.ts'
import { startControlPanel } from '../lib/server/official/control-panel.ts'

const root = process.env.APP_ROOT_DIR
const state = process.env.USER_DATA_DIR
if (!root || !state || !process.env.RVB_POSTGRES_URL) throw new Error('缺少官方服务路径或独立数据库配置')
fs.mkdirSync(state, { recursive: true, mode: 0o700 })
const configFile = path.join(state, 'smtp.json')
let settings = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null
let mailer = settings ? createSmtpMailer(settings) : null
const mail = {
  status: () => mailer ? mailer.status() : { host: '尚未配置', port: 465, sent: 0, failed: 0, checkedAt: null, connected: false, lastSentAt: null, lastFailedAt: null },
  verify: async () => { if (!mailer) throw new Error('请先配置 SMTP'); return mailer.verify() },
}
const server = await createOfficialServer({ databaseUrl: process.env.RVB_POSTGRES_URL, mail: async (...args) => { if (!mailer) throw new Error('邮件服务尚未配置'); return mailer.send(...args) } })
if (!mailer) await server.ranked.administer('maintenance', 'on', '首次部署等待邮件配置')
let closing = false
let panel
const panelFile = path.join(state, 'control-panel.url')
async function shutdown() {
  if (closing) return
  closing = true
  fs.rmSync(panelFile, { force: true })
  if (panel) await panel.close()
  try { await server.close() } finally { mailer?.close() }
}
const operations = {
  read: async () => ({ smtp: settings ? { host: settings.host, port: settings.port, user: settings.user, from: settings.from } : { host: '', port: 465, user: '', from: '' }, backups: [] }),
  execute: async (action, input) => {
    if (action !== 'smtp-save') throw new Error('Linux数据库备份请使用服务器运维；暂不支持此恢复操作')
    const next = { ...input.smtp, password: input.smtp?.password || settings?.password }
    const candidate = createSmtpMailer(next)
    try {
      await candidate.verify()
      fs.writeFileSync(configFile + '.tmp', JSON.stringify(next), { mode: 0o600 })
      fs.renameSync(configFile + '.tmp', configFile)
    } catch (error) { candidate.close(); throw error }
    const previous = mailer
    settings = next; mailer = candidate; previous?.close()
    await server.pool.query('INSERT INTO official_audit(action,detail) VALUES($1,$2)', [action, { value: 'SMTP配置（凭据不记录）', reason: String(input.reason || '') }])
  },
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown() })
try {
  const port = Number(process.env.PORT || 2568)
  await server.start(port, '127.0.0.1')
  panel = await startControlPanel({ ranked: server.ranked, mail, assetsRoot: path.join(root, 'control-panel'), pagesRoot: path.join(root, 'data/pages'), playerPort: port, shutdown, operations })
  fs.writeFileSync(panelFile, panel.url, { mode: 0o600 })
  console.info('官方服务与本机指挥台已启动；管理地址保存在受限数据目录。')
} catch (error) { await shutdown(); throw error }
