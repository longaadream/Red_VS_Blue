import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
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
async function remote(c, action) {
  const script = await fs.readFile(path.join(here, 'remote.sh'), 'utf8')
  return run('ssh', [...sshArgs(c), `bash -s -- ${action} ${c.service} '${c.database}' '${c.release}'`], script)
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
export async function execute(input) {
  const c = validate(input)
  const action = input.action
  if (!['status', 'logs', 'backup', 'stage', 'activate'].includes(action)) throw Error('操作无效')
  if (['backup', 'activate'].includes(action) && c.service !== 'rvb-relay' && !c.database) throw Error('请填写数据库名称，更新前需要备份')
  if (['stage', 'activate'].includes(action) && !c.release) throw Error('请填写版本名称')
  if (action === 'activate' && input.maintenance !== true) throw Error('请确认已结束现有对局，且本版本不含数据库迁移')
  if (action !== 'stage') return remote(c, action)
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
    await remote(c, 'prepare')
    await run('scp', ['-i', c.key, '-P', c.port, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-r', copy + '/.', `${c.user}@${c.host}:/opt/rvb/releases/${c.release}/`])
    return `${count} 个文件上传完成\n${await remote(c, 'verify')}\n尚未启用。`
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
}
export async function serve({ proxyRunner = run } = {}) {
  const token = randomBytes(32).toString('hex')
  let busy = false
  let panelConnection
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'")
    const origin = `http://127.0.0.1:${server.address().port}`
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return }
    if (req.method === 'GET' && ['/', '/panel.js', '/panel.css', '/bridge.js', '/wood.svg', '/font.ttf'].includes(req.url)) {
      const root = path.resolve(here, '../..')
      const file = req.url === '/' ? path.join(root, 'lib/server/official/panel/index.html')
        : req.url === '/bridge.js' ? path.join(here, 'bridge.js')
          : req.url === '/wood.svg' || req.url === '/font.ttf' ? path.join(root, 'data/pages/images/tabletop', req.url === '/wood.svg' ? 'table-wood.svg' : 'ZCOOLKuaiLe-Regular.ttf')
            : path.join(root, 'lib/server/official/panel', req.url.slice(1))
      let bytes = await fs.readFile(file)
      if (req.url === '/') bytes = Buffer.from(bytes.toString().replace('</nav>', '<a id="ops-link" href="/ops">服务器运维与连接 →</a></nav>').replace('</body>', '<script src="/bridge.js" defer></script></body>'))
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.svg') ? 'image/svg+xml' : req.url.endsWith('.ttf') ? 'font/ttf' : 'text/html; charset=utf-8')
      res.end(bytes); return
    }
    if (req.method === 'GET' && ['/ops', '/ui.js', '/style.css'].includes(req.url)) {
      const file = req.url === '/ops' ? 'index.html' : req.url.slice(1)
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8')
      res.end(await fs.readFile(path.join(here, file))); return
    }
    if (!['GET', 'POST'].includes(req.method) || (req.method === 'POST' ? req.headers.origin !== origin : req.headers.origin && req.headers.origin !== origin) || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return }
    if (busy) { res.writeHead(409).end('已有操作正在执行'); return }
    busy = true
    try {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 12000) throw Error('请求过大') }
      if (req.url?.startsWith('/api/')) {
        if (!panelConnection) throw Error('尚未连接官方指挥台。请打开“服务器运维与连接”配置；香港排位服务目前尚未部署。')
        const route = new URL(req.url, origin)
        if (!(req.method === 'GET' && ['/api/snapshot', '/api/config', '/api/accounts', '/api/matches', '/api/audit'].includes(route.pathname) || req.method === 'POST' && route.pathname === '/api/action')) throw Error('接口无效')
        const remoteOrigin = `http://127.0.0.1:${panelConnection.panelPort}`
        const curl = [`url = ${JSON.stringify(remoteOrigin + route.pathname + route.search)}`, `header = ${JSON.stringify('Authorization: Bearer ' + panelConnection.panelToken)}`, `header = ${JSON.stringify('Origin: ' + remoteOrigin)}`, 'header = "Content-Type: application/json"', 'max-time = 300', 'silent', 'show-error', 'fail-with-body']
        if (req.method === 'POST') curl.push('request = "POST"', `data = ${JSON.stringify(body)}`)
        const result = await proxyRunner('ssh', [...sshArgs(panelConnection), 'curl --config -'], curl.join('\n'), 315000)
        const value = JSON.parse(result)
        if (route.pathname === '/api/snapshot') value.playerUrl = 'https://play.redvsblue.top/official.html'
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return
      }
      if (req.method !== 'POST' || req.url !== '/api') throw Error('接口无效')
      const input = JSON.parse(body)
      if (input.action === 'connect-panel') {
        const c = validate(input)
        if (!input.panelPort && !input.panelToken) {
          const address = (await run('ssh', [...sshArgs(c), 'cat /var/lib/rvb-official/control-panel.url'])).trim()
          const url = new URL(address)
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('远程管理地址无效')
          input.panelPort = url.port; input.panelToken = url.hash.slice(1)
        }
        if (!/^\d+$/.test(String(input.panelPort)) || +input.panelPort < 1 || +input.panelPort > 65535 || !/^[a-zA-Z0-9_-]{32,128}$/.test(input.panelToken || '')) throw Error('请输入远程指挥台的回环端口和会话令牌')
        panelConnection = { ...c, panelPort: Number(input.panelPort), panelToken: input.panelToken }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ output: '连接配置已保存到本次进程内存。返回指挥台读取实际数据；重启后需重新连接。' })); return
      }
      const output = await execute(input)
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ output }))
    } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
    finally { busy = false }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  console.log(`管理界面：http://127.0.0.1:${server.address().port}/#${token}`)
  return server
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === 'cli') {
    execute(JSON.parse(await fs.readFile(process.argv[3], 'utf8'))).then(console.log).catch(error => { console.error(error.message); process.exitCode = 1 })
  } else await serve()
}
