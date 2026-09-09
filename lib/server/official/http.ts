import express, { type Express, type Request, type Response } from 'express'
import { Accounts, OfficialError } from './accounts'
import { Ranked } from './ranked'
import type { PostgresBattleReportReader } from '../postgres/authority-types'
import { rankedMapCatalog, validateRankedMapPool } from './pregame'

export function mountOfficialApi(app: Express, accounts: Accounts, ranked: Ranked, reports: PostgresBattleReportReader) {
  app.use('/official', express.json({ limit: '8kb', strict: true }))
  const token = (request: Request) => String(request.headers.authorization ?? '').replace(/^Bearer /, '')
  function endpoint(path: string, handler: (request: Request) => Promise<unknown>, post = false) {
    const route = async (request: Request, response: Response) => {
      response.setHeader('Cache-Control', 'no-store')
      try {
        await accounts.limit(`http:${request.socket.remoteAddress ?? 'unknown'}`, 12000, 60)
        if (post && /^\/official\/auth\//.test(path)) await accounts.limit(`auth-ip:${request.socket.remoteAddress ?? 'unknown'}`, 120, 60)
        response.json(await handler(request))
      } catch (error) {
        response.status(error instanceof OfficialError ? error.status : 503).json({ error: error instanceof OfficialError ? error.message : '服务暂不可用，请稍后重试' })
      }
    }
    if (post) app.post(path, route); else app.get(path, route)
  }
  endpoint('/official/info', async () => ({ kind: 'rvb-official-v1', ...ranked.health(), announcement: (await ranked.pool.query('SELECT announcement FROM official_settings')).rows[0].announcement, rating: { initial: 1000, k: 32 }, mode: '1v1' }))
  for (const [path, purpose] of [['register', 'verify'], ['forgot', 'reset']] as const) {
    endpoint(`/official/auth/${path}`, async request => { await accounts.requestCode(purpose, request.body ?? {}); return { message: '如果该邮箱可以执行此操作，验证邮件已发送，请检查收件箱和垃圾邮件' } }, true)
  }
  for (const [path, purpose] of [['verify', 'verify'], ['reset', 'reset']] as const) endpoint(`/official/auth/${path}`, async request => {
    await accounts.redeem(purpose, request.body ?? {}); return { message: '操作成功，请登录' }
  }, true)
  endpoint('/official/auth/login', request => accounts.login(request.body ?? {}), true)
  endpoint('/official/auth/logout', async request => { await accounts.logout(token(request)); return { ok: true } }, true)
  endpoint('/official/me', async request => {
    const account = await accounts.authenticate(token(request))
    return { account: { id: account.id, name: account.name, email: account.email }, ...await ranked.status(account.id) }
  })
  endpoint('/official/queue/join', async request => { const account = await accounts.authenticate(token(request)); await ranked.enqueue(account.id, request.body?.profileIdentity); return { ok: true } }, true)
  endpoint('/official/queue/cancel', async request => { const account = await accounts.authenticate(token(request)); await ranked.cancel(account.id); return { ok: true } }, true)
  endpoint('/official/leaderboard', async () => ({ players: await ranked.leaderboard() }))
  endpoint('/official/maps', async () => ({ maps: rankedMapCatalog(validateRankedMapPool((await ranked.pool.query('SELECT ranked_maps FROM official_settings')).rows[0].ranked_maps)) }))
  endpoint('/official/pregame/:matchId', async request => {
    const account = await accounts.authenticate(token(request))
    return ranked.preparation(String(request.params.matchId), account.id)
  })
  endpoint('/official/pregame/:matchId', async request => {
    const account = await accounts.authenticate(token(request))
    return ranked.preparation(String(request.params.matchId), account.id, request.body ?? {})
  }, true)
  endpoint('/official/pregame/:matchId/withdraw', async request => {
    const account = await accounts.authenticate(token(request))
    return ranked.withdraw(String(request.params.matchId), account.id)
  }, true)
  endpoint('/battle-reports/:battleId', async request => {
    const account = await accounts.authenticate(token(request))
    const report = await reports.readBattleReport(String(request.params.battleId))
    if (!report || !report.room.players.some(p => p.id === account.id)) throw new OfficialError('没有该战报的读取权限', 403)
    return report
  })
}
