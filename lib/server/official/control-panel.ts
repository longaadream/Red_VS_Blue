import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { matchMaker } from 'colyseus'
import { OfficialError } from './accounts'
import type { Ranked } from './ranked'
import type { createSmtpMailer } from './mail'

type Mail = Pick<ReturnType<typeof createSmtpMailer>, 'status' | 'verify'>
export async function startControlPanel(options: { ranked: Ranked; mail: Mail; assetsRoot: string; pagesRoot: string; playerPort: number; shutdown: () => Promise<void> }) {
  const token = randomBytes(32).toString('base64url'), startedAt = Date.now()
  const assets = new Map<string, { body: Buffer; type: string }>()
  for (const [url, file, type] of [
    ['/', path.join(options.assetsRoot, 'index.html'), 'text/html; charset=utf-8'],
    ['/panel.css', path.join(options.assetsRoot, 'panel.css'), 'text/css; charset=utf-8'],
    ['/panel.js', path.join(options.assetsRoot, 'panel.js'), 'text/javascript; charset=utf-8'],
    ['/wood.svg', path.join(options.pagesRoot, 'images/tabletop/table-wood.svg'), 'image/svg+xml'],
    ['/font.ttf', path.join(options.pagesRoot, 'images/tabletop/ZCOOLKuaiLe-Regular.ttf'), 'font/ttf'],
  ]) assets.set(url, { body: readFileSync(file), type })
  let origin = '', mutating = false, closing = false, lastMailCheck = 0
  const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
  async function body(req: IncomingMessage) {
    if (req.headers['content-type'] !== 'application/json') throw new OfficialError('需要JSON请求', 415)
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new OfficialError('请求过大', 413); chunks.push(chunk) }
    try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value as Record<string, unknown> }
    catch { throw new OfficialError('请求格式错误') }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    try {
      if (req.headers.host !== new URL(origin).host || req.socket.remoteAddress !== '127.0.0.1') throw new OfficialError('仅允许本机管理', 403)
      const url = new URL(req.url || '/', origin)
      if (req.method === 'GET' && assets.has(url.pathname)) { const asset = assets.get(url.pathname)!; res.writeHead(200, { 'Content-Type': asset.type }); res.end(asset.body); return }
      const provided = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, '')), expected = Buffer.from(token)
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new OfficialError('管理会话失效，请重新运行 Open-Control-Panel.cmd', 403)
      if (req.headers.origin && req.headers.origin !== origin) throw new OfficialError('请求来源不符', 403)
      if (closing) throw new OfficialError('服务器正在停止，请用 Start-Official.cmd 重新启动', 503)
      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        const pool = options.ranked.pool
        const settings = (await pool.query('SELECT season_id,maintenance FROM official_settings')).rows[0]
        const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM official_accounts) accounts,
          (SELECT count(*)::int FROM official_queue WHERE seen_at>now()-interval '20 seconds') queued,
          (SELECT count(*)::int FROM official_matches WHERE status='assigned') active,
          (SELECT count(*)::int FROM official_matches WHERE status='settled') settled`)).rows[0]
        const rooms = await matchMaker.query({ name: 'battle' })
        const connections = rooms.reduce((sum, room) => sum + (matchMaker.getLocalRoomById(room.roomId)?.clients.length || 0), 0)
        json(res, 200, { settings, counts, connections, health: options.ranked.health(), runtime: { uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), memoryMiB: Math.round(process.memoryUsage().rss / 1048576), database: 'connected', poolActive: pool.totalCount - pool.idleCount, poolWaiting: pool.waitingCount }, mail: options.mail.status(), playerUrl: `http://127.0.0.1:${options.playerPort}/official.html` }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 254), offset = Math.min(1000000, Math.max(0, Number(url.searchParams.get('offset')) || 0)) | 0
        const rows = (await options.ranked.pool.query(`SELECT a.id,a.name,a.banned,a.created_at,
          left(split_part(a.email,'@',1),1)||'***@'||split_part(a.email,'@',2) email,
          coalesce(r.rating,1000) rating,coalesce(r.games,0) games
          FROM official_accounts a LEFT JOIN official_ratings r ON r.account_id=a.id AND r.season_id=(SELECT season_id FROM official_settings)
          WHERE $1='' OR strpos(lower(a.name),lower($1))>0 OR strpos(a.email,lower($1))>0 OR a.id=$1
          ORDER BY a.created_at DESC,a.id LIMIT 31 OFFSET $2`, [q, offset])).rows
        json(res, 200, { rows: rows.slice(0, 30), more: rows.length > 30 }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/matches') {
        const filter = url.searchParams.get('status') || 'assigned'
        if (!['assigned', 'settled', 'void'].includes(filter)) throw new OfficialError('对局筛选无效')
        const rows = (await options.ranked.pool.query(`SELECT m.id,m.season_id,m.status,m.created_at,m.finished_at,a.name first_name,b.name second_name,
          m.result->>'winnerId' winner_id,m.first_id,m.second_id FROM official_matches m
          JOIN official_accounts a ON a.id=m.first_id JOIN official_accounts b ON b.id=m.second_id
          WHERE m.status=$1 ORDER BY m.created_at DESC,m.id LIMIT 100`, [filter])).rows
        json(res, 200, { rows }); return
      }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        json(res, 200, { rows: (await options.ranked.pool.query(`SELECT id,action,detail->>'value' value,created_at FROM official_audit ORDER BY id DESC LIMIT 100`)).rows }); return
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        if (req.headers.origin !== origin) throw new OfficialError('请求来源不符', 403)
        const input = await body(req)
        if (mutating) throw new OfficialError('上一项操作尚未完成，请稍后重试', 409)
        mutating = true
        try {
          const action = String(input.action || ''), value = String(input.value || '')
          if (action === 'mail-check') {
            if (Date.now() - lastMailCheck < 15000) throw new OfficialError('请间隔15秒再检查', 429)
            lastMailCheck = Date.now()
            try { await options.mail.verify() } catch { throw new OfficialError('SMTP连接或认证失败，请检查网络、邮箱SMTP服务和本机授权码', 503) }
          } else if (action === 'stop') {
            await options.ranked.prepareShutdown(); closing = true
            // Once prepared, a closed browser must not strand the service half-stopped.
            let scheduled = false
            const stop = () => { if (scheduled) return; scheduled = true; setImmediate(() => { void options.shutdown().catch(() => console.error('[official-panel] SHUTDOWN_FAILED')) }) }
            res.once('finish', stop); res.once('close', stop)
            if (res.destroyed) stop()
          } else if (['maintenance', 'ban', 'unban', 'season'].includes(action)) await options.ranked.administer(action, value)
          else throw new OfficialError('未知管理操作')
          json(res, 200, { ok: true }); return
        } finally { mutating = false }
      }
      throw new OfficialError('未找到接口', 404)
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof OfficialError ? error.status : 503, { error: error instanceof OfficialError ? error.message : '操作暂时失败，请检查服务终端和数据库状态后重试' })
    }
  })
  server.requestTimeout = 20000; server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { url: `${origin}/#${token}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() }) }
}
