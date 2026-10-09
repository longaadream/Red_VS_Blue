import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
export const TOOL_VERSION = 'RED-248.1'
const defaultSettingsPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.config'), 'RedVsBlue', 'server-admin', 'connection.json')
function publicConnection(input) {
  const c = validate(input)
  return Object.fromEntries(['host', 'user', 'port', 'key', 'service', 'database'].map(key => [key, c[key]]))
}
export function validate(input) {
  const c = { host: input.host, user: input.user || 'root', port: String(input.port || 22), key: input.key, service: input.service || 'rvb-game', database: input.database || '', release: input.release || '' }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(c.host || '') || !/^[a-z_][a-z0-9_-]*$/.test(c.user)) throw Error('服务器地址或用户无效')
  if (!/^\d+$/.test(c.port) || +c.port < 1 || +c.port > 65535) throw Error('SSH 端口无效')
  if (!path.isAbsolute(c.key || '')) throw Error('密钥请填写本机绝对路径')
  if (!['rvb-game', 'rvb-relay', 'rvb-official'].includes(c.service)) throw Error('服务无效')
  if (c.database && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(c.database)) throw Error('数据库名称无效')
  if (c.release && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(c.release)) throw Error('版本名称无效')
  return c
}
function run(command, args, stdin = '', timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('操作超时；远程操作可能仍在运行，请查询状态后再操作。')) }, timeoutMs)
    const append = bytes => { output = (output + bytes.toString()).slice(-180000) }
    child.stdout.on('data', append); child.stderr.on('data', append)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(Error(output || `命令失败：${code}`)) })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}
function sshArgs(c) { return ['-i', c.key, '-p', c.port, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', `${c.user}@${c.host}`] }
export function normalizeShellScript(script) {
  return script.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}
async function remote(c, action, runner, readScript) {
  const script = normalizeShellScript(await readScript())
  return runner('ssh', [...sshArgs(c), `bash -s -- ${action} ${c.service} '${c.database}' '${c.release}'`], script)
}
export async function verifyPackage(directory) {
  const manifest = await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')
  const entries = manifest.trim().split(/\r?\n/).map(line => {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9_./-]+)$/.exec(line)
    if (!match || match[2].startsWith('/') || match[2].split('/').some(p => !p || p === '.' || p === '..')) throw Error('版本清单路径无效')
    return { hash: match[1], file: match[2] }
  })
  const names = new Set(entries.map(e => e.file))
  if (names.size !== entries.length) throw Error('版本清单有重复文件')
  const walk = async (dir, prefix = '') => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + item.name
      if (item.isSymbolicLink()) throw Error('部署包不允许符号链接')
      if (item.isDirectory()) await walk(path.join(dir, item.name), name + '/')
      else if (!item.isFile() || name !== 'SHA256SUMS' && !names.has(name)) throw Error('部署包存在清单外文件：' + name)
    }
  }
  await walk(directory)
  for (const entry of entries) {
    const bytes = await fs.readFile(path.join(directory, entry.file))
    if (createHash('sha256').update(bytes).digest('hex') !== entry.hash) throw Error('校验失败：' + entry.file)
  }
  return entries.length
}
export async function execute(input, { runner = run, readScript = () => fs.readFile(path.join(here, 'remote.sh'), 'utf8') } = {}) {
  const c = validate(input)
  const action = input.action
  if (!['status', 'logs', 'backup', 'stage', 'activate'].includes(action)) throw Error('操作无效')
  if (['backup', 'activate'].includes(action) && c.service !== 'rvb-relay' && !c.database) throw Error('请填写数据库名称，更新前需要备份')
  if (['stage', 'activate'].includes(action) && !c.release) throw Error('请填写版本名称')
  if (action === 'activate' && input.maintenance !== true) throw Error('请确认已结束现有对局，且本版本不含数据库迁移')
  if (action !== 'stage') return remote(c, action, runner, readScript)
  const directory = path.resolve(input.directory || '')
  if (!input.directory) throw Error('请选择本机构建目录')
  const count = await verifyPackage(directory)
  await fs.access(path.join(directory, c.service === 'rvb-relay' ? 'relay.mjs' : c.service === 'rvb-game' ? 'colyseus-server.mjs' : 'official-server.mjs'))
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rvb-stage-'))
  try {
    // Copy only the verified package; scp receives a fixed remote path.
    const copy = path.join(temporary, 'package')
    await fs.cp(directory, copy, { recursive: true })
    await verifyPackage(copy)
    await remote(c, 'prepare', runner, readScript)
    await runner('scp', ['-i', c.key, '-P', c.port, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-r', copy + '/.', `${c.user}@${c.host}:/opt/rvb/releases/${c.release}/`])
    return `${count} 个文件上传完成\n${await remote(c, 'verify', runner, readScript)}\n尚未启用。`
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
}
/** @param {{proxyRunner?: typeof run, commandRunner?: typeof run, settingsPath?: string | false}} [options] */
export async function serve({ proxyRunner = run, commandRunner = run, settingsPath = false } = {}) {
  const token = randomBytes(32).toString('hex')
  let busy = false
  let panelConnection
  let savedConnection = null
  if (settingsPath) {
    try { savedConnection = publicConnection(JSON.parse(await fs.readFile(settingsPath, 'utf8'))) }
    catch (error) { if (error.code !== 'ENOENT') throw Error('无法读取服务器连接配置，请检查本机配置文件：' + settingsPath) }
  }
  async function saveConnection(input) {
    const connection = publicConnection(input)
    if (settingsPath) {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true })
      const temporary = settingsPath + '.' + randomBytes(6).toString('hex') + '.tmp'
      try { await fs.writeFile(temporary, JSON.stringify(connection, null, 2), { mode: 0o600 }); await fs.rename(temporary, settingsPath) }
      finally { await fs.rm(temporary, { force: true }) }
    }
    savedConnection = connection
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'")
    const origin = `http://127.0.0.1:${server.address().port}`
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return }
    if (req.method === 'GET' && ['/', '/ops', '/panel.js', '/panel.css', '/bridge.js', '/wood.svg', '/font.ttf'].includes(req.url)) {
      const root = path.resolve(here, '../..')
      const isPage = req.url === '/' || req.url === '/ops'
      const file = isPage ? path.join(root, 'lib/server/official/panel/index.html')
        : req.url === '/bridge.js' ? path.join(here, 'bridge.js')
          : req.url === '/wood.svg' || req.url === '/font.ttf' ? path.join(root, 'data/pages/images/tabletop', req.url === '/wood.svg' ? 'table-wood.svg' : 'ZCOOLKuaiLe-Regular.ttf')
            : path.join(root, 'lib/server/official/panel', req.url.slice(1))
      let bytes = await fs.readFile(file)
      if (isPage) {
        const fragment = await fs.readFile(path.join(here, 'ops-fragment.html'), 'utf8')
        bytes = Buffer.from(bytes.toString().replace('<section id="remote-ops" data-ops-section="remote-ops" hidden></section>', fragment).replace('</body>', '<script src="/bridge.js" defer></script><script src="/ui.js" defer></script></body>'))
      }
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.svg') ? 'image/svg+xml' : req.url.endsWith('.ttf') ? 'font/ttf' : 'text/html; charset=utf-8')
      res.end(bytes); return
    }
    if (req.method === 'GET' && ['/ui.js', '/style.css'].includes(req.url)) {
      const file = req.url.slice(1)
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8')
      res.end(await fs.readFile(path.join(here, file))); return
    }
    if (!['GET', 'POST'].includes(req.method) || (req.method === 'POST' ? req.headers.origin !== origin : req.headers.origin && req.headers.origin !== origin) || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return }
    if (req.method === 'GET' && req.url === '/api/local-status') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ toolVersion: TOOL_VERSION, connected: Boolean(panelConnection?.ready), connection: savedConnection })); return
    }
    const exclusive = req.method === 'POST'
    if (exclusive && busy) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '已有操作正在执行，请稍后重试' })); return }
    if (exclusive) busy = true
    try {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 12000) throw Error('请求过大') }
      if (req.url?.startsWith('/api/')) {
        if (!panelConnection) throw Error('尚未连接服务器。请先填写 SSH 连接配置并连接指挥台。')
        const route = new URL(req.url, origin)
        if (!(req.method === 'GET' && ['/api/snapshot', '/api/config', '/api/accounts', '/api/matches', '/api/audit', '/api/community'].includes(route.pathname) || req.method === 'POST' && route.pathname === '/api/action')) throw Error('接口无效')
        const connection = panelConnection
        const remoteOrigin = `http://127.0.0.1:${connection.panelPort}`
        const curl = [`url = ${JSON.stringify(remoteOrigin + route.pathname + route.search)}`, `header = ${JSON.stringify('Authorization: Bearer ' + panelConnection.panelToken)}`, `header = ${JSON.stringify('Origin: ' + remoteOrigin)}`, 'header = "Content-Type: application/json"', 'max-time = 300', 'silent', 'show-error', 'write-out = "\\n__RVB_HTTP_STATUS__:%{http_code}"']
        if (req.method === 'POST') curl.push('request = "POST"', `data = ${JSON.stringify(body)}`)
        const result = await proxyRunner('ssh', [...sshArgs(panelConnection), 'curl --config -'], curl.join('\n'), 315000)
        const match = /\n__RVB_HTTP_STATUS__:(\d{3})$/.exec(result)
        const status = match ? Number(match[1]) : 200
        if (status < 100 || status > 599) throw Error('远程管理接口未返回有效 HTTP 状态')
        let value
        try { value = JSON.parse(match ? result.slice(0, match.index) : result) }
        catch { value = { error: status === 404 ? '服务器尚不支持此功能，请升级服务器。' : '远程管理接口返回了无法识别的响应，请检查服务器版本和日志。' }; if (status < 400) throw Error(value.error) }
        if (route.pathname === '/api/snapshot') {
          if (panelConnection === connection) connection.ready = status === 200
          // A remote loopback address is not a usable public player endpoint.
          if (status === 200) value.playerUrl = null
        }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); return
      }
      if (req.method !== 'POST' || req.url !== '/api') throw Error('接口无效')
      const input = JSON.parse(body)
      if (input.action === 'save-connection') {
        await saveConnection(input)
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ output: '连接配置已保存在本机，不包含管理令牌或密钥内容。' })); return
      }
      if (input.action === 'connect-panel') {
        const c = validate(input)
        if (!input.panelPort && !input.panelToken) {
          const address = (await commandRunner('ssh', [...sshArgs(c), 'cat /var/lib/rvb-official/control-panel.url'])).trim()
          const url = new URL(address)
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('远程管理地址无效')
          input.panelPort = url.port; input.panelToken = url.hash.slice(1)
        }
        if (!/^\d+$/.test(String(input.panelPort)) || +input.panelPort < 1 || +input.panelPort > 65535 || !/^[a-zA-Z0-9_-]{32,128}$/.test(input.panelToken || '')) throw Error('请输入远程指挥台的回环端口和会话令牌')
        await saveConnection(c)
        panelConnection = { ...c, panelPort: Number(input.panelPort), panelToken: input.panelToken, ready: false }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ output: '连接参数已保存在本机，管理令牌仅保存在本次进程内存。重启工具后请重新连接。' })); return
      }
      await saveConnection(input)
      const output = await execute(input, { runner: commandRunner })
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ output }))
    } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
    finally { if (exclusive) busy = false }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  console.log(`管理界面：http://127.0.0.1:${server.address().port}/#${token}`)
  return server
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === 'cli') {
    execute(JSON.parse(await fs.readFile(process.argv[3], 'utf8'))).then(console.log).catch(error => { console.error(error.message); process.exitCode = 1 })
  } else await serve({ settingsPath: defaultSettingsPath })
}
