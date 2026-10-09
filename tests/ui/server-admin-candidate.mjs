// Local QA only: real isolated PostgreSQL and panel, with an in-process SSH transport substitute.
// Run: node --import tsx tests/ui/server-admin-candidate.mjs
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import postgresModule from '../../electron-client/embedded-postgres.ts'
import portModule from '../../electron-client/local-port.ts'
import serverModule from '../../lib/server/official/server.ts'
import panelModule from '../../lib/server/official/control-panel.ts'
import { serve } from '../../scripts/server-admin/admin.mjs'
const { EmbeddedPostgresController } = postgresModule
const { findFreePort } = portModule
const { createOfficialServer } = serverModule
const { startControlPanel } = panelModule
const legacy = process.argv.includes('--legacy')

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rvb-red248-qa-'))
const pg = new EmbeddedPostgresController({ runtimeRoot: path.resolve('_client-postgres/pgsql'), stateRoot, findFreePort, portHint: 39081, protectSecret: value => Buffer.from(value), unprotectSecret: value => value.toString() })
let app, panel, admin
let shuttingDown = false
async function stop(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  if (admin) await new Promise(resolve => admin.close(resolve))
  await panel?.close()
  await app?.close()
  await pg.stop()
  process.exit(code)
}
try {
  const db = await pg.start()
  await fs.writeFile(path.join(stateRoot, 'test-database-url.txt'), db.url, { mode: 0o600 })
  app = await createOfficialServer({ databaseUrl: db.url, mail: async () => {} })
  const playerPort = await findFreePort(39082)
  await app.start(playerPort)
  await app.pool.query("INSERT INTO official_accounts(id,email,name,password_hash) VALUES('qa-admin-a','qa-a@example.test','测试账号甲','fixture-only'),('qa-admin-b','qa-b@example.test','测试账号乙','fixture-only')")
  await app.community.createPost('qa-admin-a', { kind: 'discussion', title: '候选界面验收', body: '这是隔离数据库中的测试内容。' })
  panel = await startControlPanel({ ranked: app.ranked, community: app.community, mail: { status: () => ({ host: 'smtp.example.test', port: 465, sent: 0, failed: 0, connected: null, checkedAt: null }), verify: async () => true }, assetsRoot: path.resolve('lib/server/official/panel'), pagesRoot: path.resolve('data/pages'), playerPort, shutdown: async () => {} })
  const remote = new URL(panel.url)
  const proxyRunner = async (_command, _args, input) => {
    const values = input.split('\n')
    const read = key => JSON.parse(values.find(line => line.startsWith(key + ' = ')).slice(key.length + 3))
    const target = new URL(read('url'))
    if (target.origin !== remote.origin) throw Error('QA transport only accepts the isolated panel')
    if (legacy && target.pathname === '/api/community') return 'Not found\n__RVB_HTTP_STATUS__:404'
    const headers = Object.fromEntries(values.filter(line => line.startsWith('header = ')).map(line => {
      const text = JSON.parse(line.slice(9)), colon = text.indexOf(':')
      return [text.slice(0, colon), text.slice(colon + 1).trim()]
    }))
    const body = values.some(line => line.startsWith('data = ')) ? read('data') : undefined
    const response = await fetch(target, { method: body ? 'POST' : 'GET', headers, body })
    if (legacy && target.pathname === '/api/snapshot' && response.ok) {
      const snapshot = await response.json()
      delete snapshot.capabilities
      delete snapshot.rankedMaps
      return JSON.stringify(snapshot) + '\n__RVB_HTTP_STATUS__:200'
    }
    return (await response.text()) + '\n__RVB_HTTP_STATUS__:' + response.status
  }
  const commandRunner = async (_command, args) => {
    if (args.at(-1) === 'cat /var/lib/rvb-official/control-panel.url') return panel.url
    return '【QA 模拟 SSH 输出】\nActiveState=active\nSubState=running\n当前版本：RED-248 本机候选\n真实数据库与运营接口已启动，未连接远程服务器。'
  }
  admin = await serve({ proxyRunner, commandRunner, settingsPath: path.join(stateRoot, 'connection.json') })
  console.log('QA_STATE_ROOT=' + stateRoot)
  console.log('QA transport is simulated; PostgreSQL and all panel actions are real and isolated. Type stop to exit.')
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', data => { if (data.trim() === 'stop') void stop() })
  process.on('SIGINT', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
  setInterval(() => { void fs.access(path.join(stateRoot, 'STOP')).then(() => stop()).catch(error => { if (error.code !== 'ENOENT') console.error(error.message) }) }, 1000)
} catch (error) {
  console.error(error)
  await stop(1)
}
