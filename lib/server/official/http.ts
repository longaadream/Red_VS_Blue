import express, { type Express, type Request, type Response } from 'express'
import { Accounts, OfficialError } from './accounts'
import { Ranked } from './ranked'
import type { PostgresBattleReportReader } from '../postgres/authority-types'
import { rankedMapCatalog, validateRankedMapPool } from './pregame'
import type { Community } from './community'
import type { PlayerProfilesApi } from './player-profiles'
import type { OfficialReplayService } from './player-replay'
import type { RoomInvitations } from './room-invitations'

export function mountOfficialApi(app: Express, accounts: Accounts, ranked: Ranked, reports: PostgresBattleReportReader, injectedCommunity?: Community,
  playerServices?: { profiles: PlayerProfilesApi; replay: OfficialReplayService; invitations: RoomInvitations }) {
  app.use('/official', express.json({ limit: '8kb', strict: true }))
  const community = injectedCommunity ?? (ranked as Ranked & { community?: Community }).community
  const token = (request: Request) => String(request.headers.authorization ?? '').replace(/^Bearer /, '')
  const communityService = () => {
    if (!community) throw new OfficialError('社区服务暂不可用，请稍后重试', 503)
    return community
  }
  const communityAccount = async (request: Request, write = false) => {
    const account = await accounts.authenticate(token(request))
    if (write) await accounts.limit(`community-write:${account.id}`, 120, 60)
    return account
  }
  const players = () => {
    if (!playerServices) throw new OfficialError('玩家资料服务暂不可用，请稍后重试', 503)
    return playerServices
  }
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
  endpoint('/official/players/catalog', async request => {
    await communityAccount(request)
    return players().profiles.catalog()
  })
  endpoint('/official/players/cards', async request => {
    await communityAccount(request)
    return players().profiles.cards(request.query.ids)
  })
  endpoint('/official/players/me', async request => {
    const account = await communityAccount(request, true)
    await accounts.limit(`profile-edit:${account.id}`, 10, 60)
    return players().profiles.updateProfile(account.id, request.body)
  }, true)
  endpoint('/official/players/:accountId/history', async request => {
    const account = await communityAccount(request)
    return players().profiles.history(account.id, String(request.params.accountId), request.query.cursor)
  })
  endpoint('/official/players/:accountId', async request => {
    const account = await communityAccount(request)
    return players().profiles.getProfile(account.id, String(request.params.accountId))
  })
  endpoint('/official/character-stats', async request => {
    const account = await communityAccount(request)
    await accounts.limit(`character-stats:${account.id}`, 12, 60)
    return players().profiles.characterStats()
  })
  endpoint('/official/matches/:matchId/replay', async request => {
    const account = await communityAccount(request)
    await accounts.limit(`replay-export:${account.id}`, 12, 60)
    return { trace: await players().replay.read(account.id, String(request.params.matchId)) }
  })
  endpoint('/official/community/invitations', async request => {
    const account = await communityAccount(request)
    return players().invitations.list(account.id)
  })
  endpoint('/official/community/invitations', async request => {
    const account = await communityAccount(request, true)
    return players().invitations.send(account.id, request.body)
  }, true)
  for (const action of ['accept', 'decline'] as const) endpoint(`/official/community/invitations/:invitationId/${action}`, async request => {
    const account = await communityAccount(request, true)
    return players().invitations.respond(account.id, request.params.invitationId, action === 'accept')
  }, true)
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

  // Community reads are authenticated as well as writes.  Account identity
  // always comes from the session; request bodies only carry the target and
  // content values.
  endpoint('/official/community/accounts', async request => {
    const account = await communityAccount(request)
    return { accounts: await communityService().search(account.id, request.query.q) }
  })
  endpoint('/official/community/friends', async request => {
    const account = await communityAccount(request)
    return communityService().friends(account.id)
  })
  endpoint('/official/community/heartbeat', async request => {
    const account = await communityAccount(request, true)
    await communityService().heartbeat(account.id)
    return { ok: true }
  }, true)
  for (const action of ['request', 'accept', 'reject', 'withdraw', 'remove', 'block', 'unblock'] as const) {
    endpoint(`/official/community/friends/${action}`, async request => {
      const account = await communityAccount(request, true)
      const service = communityService(), target = request.body?.targetAccountId
      if (action === 'request') await service.request(account.id, target)
      else if (action === 'accept') await service.accept(account.id, target)
      else if (action === 'reject') await service.reject(account.id, target)
      else if (action === 'withdraw') await service.withdraw(account.id, target)
      else if (action === 'remove') await service.remove(account.id, target)
      else if (action === 'block') await service.block(account.id, target)
      else await service.unblock(account.id, target)
      return { ok: true }
    }, true)
  }
  endpoint('/official/community/board', async request => {
    const account = await communityAccount(request)
    return communityService().board(account.id, request.query.cursor, request.query.limit)
  })
  endpoint('/official/community/posts', async request => {
    const account = await communityAccount(request, true)
    return { id: await communityService().createPost(account.id, request.body ?? {}) }
  }, true)
  endpoint('/official/community/posts/:postId/replies', async request => {
    const account = await communityAccount(request)
    return communityService().replies(account.id, request.params.postId, request.query.cursor, request.query.limit)
  })
  endpoint('/official/community/posts/:postId/replies', async request => {
    const account = await communityAccount(request, true)
    return { id: await communityService().createReply(account.id, request.params.postId, request.body?.body) }
  }, true)
  endpoint('/official/community/posts/:postId/delete', async request => {
    const account = await communityAccount(request, true)
    await communityService().deletePost(account.id, request.params.postId)
    return { ok: true }
  }, true)
  // Keep the short reply deletion path from the API contract, and retain the
  // nested form used by the first client implementation.
  endpoint('/official/community/replies/:replyId/delete', async request => {
    const account = await communityAccount(request, true)
    await communityService().deleteReply(account.id, request.params.replyId)
    return { ok: true }
  }, true)
  endpoint('/official/community/posts/:postId/replies/:replyId/delete', async request => {
    const account = await communityAccount(request, true)
    await communityService().deleteReply(account.id, request.params.postId, request.params.replyId)
    return { ok: true }
  }, true)
}
