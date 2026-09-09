import { Pool } from 'pg'
import { matchMaker } from 'colyseus'
import express from 'express'
import path from 'node:path'
import { equalToken } from './token'
import { createColyseusBattleServer, attachPostgresPoolErrorHandler } from '../colyseus/create-colyseus-server'
import { PostgresAuthorityRepository } from '../postgres/postgres-authority-repository'
import { ACCOUNT_SCHEMA, Accounts, type MailSender } from './accounts'
import { Ranked } from './ranked'
import { mountOfficialApi } from './http'

export async function createOfficialServer(options: { databaseUrl: string; mail: MailSender; maxMatches?: number; pagesRoot?: string; reconnectGraceMs?: number; adminToken?: string }) {
  const pool = new Pool({ connectionString: options.databaseUrl, max: 8, connectionTimeoutMillis: 10000 })
  attachPostgresPoolErrorHandler(pool)
  const repository = new PostgresAuthorityRepository(pool)
  try {
    await repository.initializeSchema()
    await pool.query(ACCOUNT_SCHEMA)
    const accounts = new Accounts(pool, options.mail), ranked = new Ranked(pool, accounts, options.maxMatches)
    await ranked.initialize()
    const authority = createColyseusBattleServer({ repository, requireIdentityProof: true, reconnectGraceMs: options.reconnectGraceMs,
      official: ranked, healthIdentity: { runtime: 'official-colyseus-postgresql', database: 'postgresql' },
      configureExpress: app => {
        mountOfficialApi(app, accounts, ranked, repository)
        if (options.adminToken) app.post('/official/admin', async (request, response) => {
          const provided = String(request.headers.authorization ?? '').replace(/^Bearer /, '')
          const expected = options.adminToken!
          if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') || !equalToken(provided, expected)) { response.status(403).json({ error: '仅允许本机管理员操作' }); return }
          try { await ranked.administer(String(request.body?.action), String(request.body?.value)); response.json({ ok: true }) }
          catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : '管理操作失败' }) }
        })
        if (options.pagesRoot) {
          app.get('/', (_request, response) => response.redirect('/official.html'))
          app.use('/images', express.static(path.resolve(options.pagesRoot, '..', '..', 'public'), { dotfiles: 'deny' }))
          for (const directory of ['cards','maps','pieces','pve','rules','skills','status-effects','tiles','tutorial']) app.use('/data/' + directory, express.static(path.resolve(options.pagesRoot, '..', directory), { dotfiles: 'deny' }))
          app.get('/data/skill-keywords.json', (_request, response) => response.sendFile(path.resolve(options.pagesRoot!, '..', 'skill-keywords.json')))
          app.use(express.static(path.resolve(options.pagesRoot), { index: false, dotfiles: 'deny' }))
        }
      },
    })
    async function start(port: number, host = '127.0.0.1') {
      await authority.server.listen(port, host)
      const restored = new Set(await authority.restoreProductRooms())
      const active = await pool.query(`SELECT m.id FROM official_matches m JOIN battle_room_authority a ON a.battle_id=m.id WHERE m.status='assigned' AND NOT EXISTS (SELECT 1 FROM battle_terminal_barrier b WHERE b.battle_id=m.id)`)
      if (active.rows.some(row => !restored.has(row.id))) throw new Error('存在未成功恢复的排位比赛，请保留数据库并检查恢复日志')
      await ranked.start({
        freeze: async id => {
          const actor = matchMaker.getLocalRoomById(id) as unknown as { freezeOfficialMatch(): Promise<void> } | undefined
          await actor?.freezeOfficialMatch()
        },
        revokeAccount: async id => {
          for (const listing of await matchMaker.query({ name: 'battle' })) {
            const actor = matchMaker.getLocalRoomById(listing.roomId) as unknown as { revokeOfficialAccount?(id: string): void } | undefined
            actor?.revokeOfficialAccount?.(id)
          }
        },
        create: async (id, first, setup) => {
          if (matchMaker.getLocalRoomById(id)) return
          if ((await pool.query('SELECT 1 FROM battle_room_authority WHERE battle_id=$1', [id])).rowCount) { await authority.restoreProductRoom(id); return }
          await matchMaker.createRoom('battle', { product: true, mode: '1v1', battleId: id, playerId: first, officialCapability: ranked.capability,
            mapId: setup?.mapId ?? 'open-expanse', officialPlayers: setup?.players, name: '官方 1v1 排位' })
        },
        dispose: async (id, onlyIfUnstarted) => {
          const room = matchMaker.getLocalRoomById(id) as unknown as { closeOfficialMatch?: (onlyIfUnstarted?: boolean) => Promise<boolean> } | undefined
          return await room?.closeOfficialMatch?.(onlyIfUnstarted) ?? true
        },
      })
    }
    async function close() {
      const failures: unknown[] = []
      for (const cleanup of [() => ranked.stop(), () => authority.journal.close(), () => authority.server.gracefullyShutdown(false), () => pool.end()]) {
        try { await cleanup() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, '官方服务已执行清理，但落盘或关闭失败；请保留数据库与日志')
    }
    return { ...authority, pool, accounts, ranked, start, close }
  } catch (error) { await pool.end(); throw error }
}
