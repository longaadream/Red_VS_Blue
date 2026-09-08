import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { BattleAuthorityCheckpointRecord } from '@/lib/game/battle-transition'
import type { BattleState } from '@/lib/game/turn'
import { Accounts, OfficialError, transaction, type Account } from './accounts'

export function eloChange(first: number, second: number, score: number) {
  return Math.round(32 * (score - 1 / (1 + 10 ** ((second - first) / 400))))
}
export const RANKED_SCHEMA = `
CREATE TABLE IF NOT EXISTS official_seasons(id TEXT PRIMARY KEY,name TEXT NOT NULL,test BOOLEAN NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO official_seasons(id,name,test) VALUES('test-1','首次测试赛季',TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS official_settings(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),season_id TEXT NOT NULL REFERENCES official_seasons(id),maintenance BOOLEAN NOT NULL DEFAULT FALSE);
INSERT INTO official_settings(singleton,season_id) VALUES(TRUE,'test-1') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS official_ratings(season_id TEXT NOT NULL REFERENCES official_seasons(id),account_id TEXT NOT NULL REFERENCES official_accounts(id),rating INTEGER NOT NULL DEFAULT 1000,games INTEGER NOT NULL DEFAULT 0,wins INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(season_id,account_id));
CREATE TABLE IF NOT EXISTS official_matches(id TEXT PRIMARY KEY,season_id TEXT NOT NULL REFERENCES official_seasons(id),first_id TEXT NOT NULL REFERENCES official_accounts(id),second_id TEXT NOT NULL REFERENCES official_accounts(id),status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','settled','void')),result JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),finished_at TIMESTAMPTZ,CHECK(first_id<>second_id));
CREATE TABLE IF NOT EXISTS official_claims(account_id TEXT PRIMARY KEY REFERENCES official_accounts(id),match_id TEXT NOT NULL REFERENCES official_matches(id));
CREATE TABLE IF NOT EXISTS official_queue(account_id TEXT PRIMARY KEY REFERENCES official_accounts(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS official_drops(match_id TEXT NOT NULL REFERENCES official_matches(id),account_id TEXT NOT NULL REFERENCES official_accounts(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(match_id,account_id));
CREATE TABLE IF NOT EXISTS official_cooldowns(account_id TEXT PRIMARY KEY REFERENCES official_accounts(id),until_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS official_audit(id BIGSERIAL PRIMARY KEY,action TEXT NOT NULL,detail JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE official_matches ADD COLUMN IF NOT EXISTS actor_closed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE official_accounts ADD COLUMN IF NOT EXISTS ranked_disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE official_settings ADD COLUMN IF NOT EXISTS max_matches INTEGER CHECK(max_matches BETWEEN 1 AND 50);
ALTER TABLE official_settings ADD COLUMN IF NOT EXISTS announcement TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS official_matches_status ON official_matches(status);
`
type Match = { id: string; season_id: string; first_id: string; second_id: string; status: string; result: unknown; created_at: Date }
export type RankedRoomHooks = {
  capability: string
  canRestore?(roomId: string): Promise<boolean>
  authorize(roomId: string, playerId: string, token: unknown, spectator?: boolean): Promise<Account>
  longDrop(roomId: string, playerId: string): Promise<void>
}
type Lifecycle = { create(id: string, first: string): Promise<void>; dispose(id: string, onlyIfUnstarted?: boolean): Promise<boolean>; revokeAccount?(id: string): Promise<void>; freeze?(id: string): Promise<void> }
export class Ranked {
  readonly capability = randomUUID()
  private lifecycle?: Lifecycle
  private timer?: NodeJS.Timeout
  private busy = false
  private stopping = false
  private lastError = ''
  constructor(readonly pool: Pool, readonly accounts: Accounts, private capacity = 10) {
    const maxMatches = capacity
    if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 50) throw new Error('排位并发局数须为1–50')
  }
  private async lock(client: PoolClient) { await client.query('SELECT pg_advisory_xact_lock(196196)') }
  get maxMatches() { return this.capacity }
  async initialize() {
    await this.pool.query(RANKED_SCHEMA)
    this.capacity = (await this.pool.query('UPDATE official_settings SET max_matches=coalesce(max_matches,$1) RETURNING max_matches', [this.capacity])).rows[0].max_matches
  }
  async start(lifecycle: Lifecycle) {
    this.lifecycle = lifecycle
    // Queues are leases, not promises to start a game after a server restart.
    await this.pool.query('DELETE FROM official_queue')
    await this.tick()
    this.timer = setInterval(() => { void this.tick() }, 1000)
  }
  async stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); while (this.busy) await new Promise(resolve => setTimeout(resolve, 20)) }
  health() { return { maxMatches: this.maxMatches, settlementHealthy: !this.lastError } }
  async canRestore(roomId: string) { return !!(await this.pool.query("SELECT 1 FROM official_matches WHERE id=$1 AND status='assigned'", [roomId])).rowCount }
  async authorize(roomId: string, playerId: string, token: unknown, spectator = false) {
    const account = await this.accounts.authenticate(token)
    if (account.id !== playerId) throw new OfficialError('账号与对局身份不匹配', 403)
    const match = (await this.pool.query('SELECT * FROM official_matches WHERE id=$1', [roomId])).rows[0] as Match | undefined
    if (!match || match.status === 'void') throw new OfficialError('排位比赛已取消或不存在', 403)
    const seated = [match.first_id, match.second_id].includes(account.id)
    if (spectator ? seated : !seated) throw new OfficialError('没有该比赛的参赛资格', 403)
    return account
  }
  async enqueue(accountId: string) {
    if (this.stopping || this.lastError) throw new OfficialError('服务器正在维护，请稍后重试', 503)
    await transaction(this.pool, async client => {
      await this.lock(client)
      const account = (await client.query('SELECT banned,ranked_disabled FROM official_accounts WHERE id=$1', [accountId])).rows[0]
      if (!account || account.banned || account.ranked_disabled) throw new OfficialError('该账号的排位资格已被限制', 403)
      if ((await client.query('SELECT maintenance FROM official_settings')).rows[0].maintenance) throw new OfficialError('排位正在维护', 503)
      if ((await client.query('SELECT 1 FROM official_claims WHERE account_id=$1', [accountId])).rowCount) throw new OfficialError('请先完成当前比赛', 409)
      if ((await client.query('SELECT 1 FROM official_cooldowns WHERE account_id=$1 AND until_at>now()', [accountId])).rowCount) throw new OfficialError('频繁长时间掉线，匹配冷却尚未结束', 429)
      await client.query(`INSERT INTO official_queue(account_id) VALUES($1) ON CONFLICT(account_id) DO UPDATE SET seen_at=now()`, [accountId])
    })
  }
  async cancel(accountId: string) {
    await transaction(this.pool, async client => { await this.lock(client); await client.query('DELETE FROM official_queue WHERE account_id=$1', [accountId]) })
  }
  async status(accountId: string) {
    await this.pool.query('UPDATE official_queue SET seen_at=now() WHERE account_id=$1', [accountId])
    const settings = (await this.pool.query('SELECT s.*,season.name,season.test FROM official_settings s JOIN official_seasons season ON season.id=s.season_id')).rows[0]
    const rating = (await this.pool.query('SELECT rating,games,wins FROM official_ratings WHERE season_id=$1 AND account_id=$2', [settings.season_id, accountId])).rows[0] ?? { rating: 1000, games: 0, wins: 0 }
    const active = (await this.pool.query('SELECT match_id FROM official_claims WHERE account_id=$1', [accountId])).rows[0]?.match_id ?? null
    const queue = await this.pool.query('SELECT created_at FROM official_queue WHERE account_id=$1', [accountId])
    const cooldown = (await this.pool.query('SELECT until_at FROM official_cooldowns WHERE account_id=$1 AND until_at>now()', [accountId])).rows[0]?.until_at ?? null
    const history = (await this.pool.query(`SELECT id,season_id,status,result,created_at,finished_at FROM official_matches WHERE first_id=$1 OR second_id=$1 ORDER BY created_at DESC LIMIT 30`, [accountId])).rows
    const badge = !!(await this.pool.query(`SELECT 1 FROM official_matches m JOIN official_seasons s ON s.id=m.season_id WHERE s.test AND m.status='settled' AND (m.first_id=$1 OR m.second_id=$1) LIMIT 1`, [accountId])).rowCount
    return { season: settings, rating, matchId: active, queued: !!queue.rowCount, queuedAt: queue.rows[0]?.created_at, cooldownUntil: cooldown, history, testParticipant: badge }
  }
  async leaderboard() {
    return (await this.pool.query(`SELECT a.id,a.name,r.rating,r.games,r.wins FROM official_ratings r JOIN official_accounts a ON a.id=r.account_id
      WHERE r.season_id=(SELECT season_id FROM official_settings) AND r.games>0 AND NOT a.banned ORDER BY r.rating DESC,r.games DESC,a.id LIMIT 100`)).rows
  }
  async longDrop(roomId: string, accountId: string) {
    await transaction(this.pool, async client => {
      const row = await client.query(`INSERT INTO official_drops(match_id,account_id) SELECT id,$2 FROM official_matches WHERE id=$1 AND status='assigned' AND ($2=first_id OR $2=second_id) ON CONFLICT DO NOTHING RETURNING match_id`, [roomId, accountId])
      if (!row.rowCount) return
      const count = Number((await client.query(`SELECT count(*) FROM official_drops WHERE account_id=$1 AND created_at>now()-interval '24 hours'`, [accountId])).rows[0].count)
      if (count >= 3) await client.query(`INSERT INTO official_cooldowns VALUES($1,now()+interval '15 minutes') ON CONFLICT(account_id) DO UPDATE SET until_at=excluded.until_at`, [accountId])
    })
  }
  async tick() {
    if (this.busy || this.stopping) return
    this.busy = true
    try {
      await this.reconcile()
      await this.pair()
      await this.pool.query(`DELETE FROM official_rate_limits WHERE expires_at<now(); DELETE FROM official_sessions WHERE expires_at<now(); DELETE FROM official_email_codes WHERE expires_at<now()`)
      this.lastError = ''
    } catch (error) {
      // Never log authentication payloads, SMTP errors or complete database rows.
      const code = (error as { code?: string }).code ?? 'OFFICIAL_TICK_FAILED'
      if (code !== this.lastError) console.error('[official] queue/settlement temporarily unavailable', { code })
      this.lastError = code
    } finally { this.busy = false }
  }
  private async pair() {
    if (!this.lifecycle) return
    let createdId: string | undefined
    try { await transaction(this.pool, async client => {
      await this.lock(client)
      await client.query(`DELETE FROM official_queue WHERE seen_at<now()-interval '20 seconds' OR account_id IN (SELECT id FROM official_accounts WHERE banned OR ranked_disabled)`)
      const settings = (await client.query('SELECT * FROM official_settings')).rows[0]
      if (settings.maintenance || this.stopping) return
      const count = Number((await client.query(`SELECT count(*) FROM official_matches WHERE status='assigned'`)).rows[0].count)
      if (count >= settings.max_matches) return
      const queue = (await client.query(`SELECT q.account_id FROM official_queue q WHERE NOT EXISTS (SELECT 1 FROM official_claims c WHERE c.account_id=q.account_id) ORDER BY q.created_at,q.account_id LIMIT 2`)).rows
      if (queue.length < 2) return
      const id = `ranked-${randomUUID()}`, first = queue[0].account_id as string, second = queue[1].account_id as string
      await client.query('INSERT INTO official_matches(id,season_id,first_id,second_id) VALUES($1,$2,$3,$4)', [id, settings.season_id, first, second])
      await client.query('INSERT INTO official_claims(account_id,match_id) VALUES($1,$3),($2,$3)', [first, second, id])
      await client.query('DELETE FROM official_queue WHERE account_id=ANY($1)', [[first, second]])
      createdId = id
      await this.lifecycle!.create(id, first)
    }) } catch (error) { if (createdId) await this.lifecycle!.dispose(createdId); throw error }
  }
  private async reconcile() {
    const matches = (await this.pool.query(`SELECT m.*,b.checkpoint_json FROM official_matches m LEFT JOIN battle_terminal_barrier b ON b.battle_id=m.id WHERE m.status='assigned'`)).rows
    for (const match of matches) {
      if (match.checkpoint_json) await this.settle(match.id)
      else if (Date.now() - new Date(match.created_at).getTime() > 180000) {
        const started = (await this.pool.query('SELECT 1 FROM battle_room_authority WHERE battle_id=$1', [match.id])).rowCount
        if (!started) {
          // Stop its actor before voiding, so roster lock cannot race into start.
          const closed = await this.lifecycle?.dispose(match.id, true)
          if (closed === false) continue
          await transaction(this.pool, async client => {
            await this.lock(client)
            const persisted = await client.query('SELECT 1 FROM battle_room_authority WHERE battle_id=$1', [match.id])
            if (!persisted.rowCount) {
              await client.query(`UPDATE official_matches SET status='void',result='{"reason":"未在三分钟内完成入场和选阵容"}',finished_at=now() WHERE id=$1 AND status='assigned'`, [match.id])
              await client.query('DELETE FROM official_claims WHERE match_id=$1', [match.id])
            }
          })
        }
      }
    }
    // Finished actors no longer need timers/AI/socket state. Reports stay in PG.
    const closed = (await this.pool.query(`SELECT id FROM official_matches WHERE status<>'assigned' AND finished_at<now()-interval '60 seconds' AND NOT actor_closed`)).rows
    for (const match of closed) {
      await this.lifecycle?.dispose(match.id)
      await this.pool.query('UPDATE official_matches SET actor_closed=TRUE WHERE id=$1', [match.id])
    }
  }
  async settle(id: string) {
    return transaction(this.pool, async client => {
      await this.lock(client)
      const match = (await client.query(`SELECT * FROM official_matches WHERE id=$1 FOR UPDATE`, [id])).rows[0] as Match | undefined
      if (!match || match.status !== 'assigned') return false
      const barrier = (await client.query('SELECT checkpoint_json FROM battle_terminal_barrier WHERE battle_id=$1', [id])).rows[0]
      if (!barrier) return false
      const checkpoint = barrier.checkpoint_json as BattleAuthorityCheckpointRecord
      const state = checkpoint.storage.state as BattleState
      const terminal = state.terminalResult
      if (!terminal || state.players.length !== 2 || !state.players.every(p => [match.first_id, match.second_id].includes(p.playerId))) throw new Error('RANKED_TERMINAL_PARTICIPANTS_INVALID')
      const winner = terminal.winnerPlayerId
      if (winner && ![match.first_id, match.second_id].includes(winner)) throw new Error('RANKED_WINNER_INVALID')
      for (const account of [match.first_id, match.second_id]) await client.query('INSERT INTO official_ratings(season_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [match.season_id, account])
      const ratings = (await client.query('SELECT account_id,rating FROM official_ratings WHERE season_id=$1 AND account_id=ANY($2) ORDER BY account_id FOR UPDATE', [match.season_id, [match.first_id, match.second_id]])).rows
      const first = Number(ratings.find(r => r.account_id === match.first_id)!.rating), second = Number(ratings.find(r => r.account_id === match.second_id)!.rating)
      const delta = eloChange(first, second, !winner ? 0.5 : winner === match.first_id ? 1 : 0)
      const result = { winnerId: winner, first: { id: match.first_id, before: first, after: first + delta, delta }, second: { id: match.second_id, before: second, after: second - delta, delta: -delta }, authorityVersion: checkpoint.authorityVersion, transitionHash: checkpoint.transitionHash }
      for (const [account, change] of [[match.first_id, delta], [match.second_id, -delta]] as const) await client.query('UPDATE official_ratings SET rating=rating+$3,games=games+1,wins=wins+$4 WHERE season_id=$1 AND account_id=$2', [match.season_id, account, change, winner === account ? 1 : 0])
      await client.query(`UPDATE official_matches SET status='settled',result=$2,finished_at=now() WHERE id=$1`, [id, result])
      await client.query('DELETE FROM official_claims WHERE match_id=$1', [id])
      return true
    })
  }
  async administer(action: string, value: string, reason = '') {
    if (action === 'void-match') return this.voidMatch(value, reason)
    if (reason.length > 300) throw new OfficialError('操作原因不能超过300字')
    if (['kick', 'rank-disable', 'rank-enable', 'cooldown-clear', 'queue-clear', 'capacity', 'announcement'].includes(action) && !reason.trim()) throw new OfficialError('请填写操作原因')
    await transaction(this.pool, async client => {
      await this.lock(client)
      if (this.stopping) throw new OfficialError('服务正在停止', 503)
      if (action === 'maintenance') {
        if (!['on', 'off'].includes(value)) throw new OfficialError('维护状态须为 on 或 off')
        await client.query('UPDATE official_settings SET maintenance=$1', [value === 'on'])
      }
      else if (['ban', 'unban', 'kick', 'rank-disable', 'rank-enable', 'cooldown-clear'].includes(action)) {
        const updated = await client.query('SELECT id FROM official_accounts WHERE id=$1 FOR UPDATE', [value])
        if (!updated.rowCount) throw new OfficialError('账号不存在')
        if (action === 'ban' || action === 'unban') await client.query('UPDATE official_accounts SET banned=$2 WHERE id=$1', [value, action === 'ban'])
        if (action === 'rank-disable' || action === 'rank-enable') await client.query('UPDATE official_accounts SET ranked_disabled=$2 WHERE id=$1', [value, action === 'rank-disable'])
        if (['ban', 'unban', 'kick'].includes(action)) await client.query('DELETE FROM official_sessions WHERE account_id=$1', [value])
        if (['ban', 'unban', 'kick', 'rank-disable'].includes(action)) await client.query('DELETE FROM official_queue WHERE account_id=$1', [value])
        if (action === 'cooldown-clear') await client.query('DELETE FROM official_cooldowns WHERE account_id=$1', [value])
      } else if (action === 'queue-clear') {
        await client.query('DELETE FROM official_queue')
      } else if (action === 'capacity') {
        const capacity = Number(value)
        if (!/^\d+$/.test(value) || !Number.isInteger(capacity) || capacity < 1 || capacity > 50) throw new OfficialError('并发上限须为1–50局')
        await client.query('UPDATE official_settings SET max_matches=$1', [capacity])
      } else if (action === 'announcement') {
        if (value.length > 1000) throw new OfficialError('公告不能超过1000字')
        await client.query('UPDATE official_settings SET announcement=$1', [value.trim()])
      } else if (action === 'season') {
        if (!/^[a-z0-9-]{1,40}$/.test(value)) throw new OfficialError('赛季编号须为小写字母、数字和连字符')
        if ((await client.query(`SELECT 1 FROM official_matches WHERE status='assigned' LIMIT 1`)).rowCount) throw new OfficialError('尚有比赛未完成，不能切换赛季')
        await client.query('INSERT INTO official_seasons(id,name,test) VALUES($1,$1,FALSE)', [value])
        await client.query('UPDATE official_settings SET season_id=$1', [value])
        await client.query('DELETE FROM official_queue')
      } else throw new OfficialError('未知管理操作')
      await client.query('INSERT INTO official_audit(action,detail) VALUES($1,$2)', [action, { value, reason: reason.trim() }])
    })
    if (action === 'capacity') this.capacity = Number(value)
    if (['ban', 'kick'].includes(action)) await this.lifecycle?.revokeAccount?.(value)
  }
  private async voidMatch(id: string, reason: string) {
    if (!reason.trim() || reason.length > 300) throw new OfficialError('请填写1–300字的作废原因')
    await transaction(this.pool, async client => {
      await this.lock(client)
      if (this.stopping) throw new OfficialError('服务正在停止', 503)
      const match = (await client.query('SELECT status FROM official_matches WHERE id=$1', [id])).rows[0]
      if (!match) throw new OfficialError('对局不存在', 404)
      if (match.status === 'settled') throw new OfficialError('已结算对局不能作废', 409)
    })
    // Never hold a database lock while waiting for the room's authority queue.
    if (!this.lifecycle?.freeze) throw new OfficialError('当前服务无法安全关闭对局', 503)
    await this.lifecycle.freeze(id)
    const ended = await transaction(this.pool, async client => {
      await this.lock(client)
      const match = (await client.query('SELECT status FROM official_matches WHERE id=$1 FOR UPDATE', [id])).rows[0]
      if (match.status === 'settled' || (await client.query('SELECT 1 FROM battle_terminal_barrier WHERE battle_id=$1', [id])).rowCount) return true
      if (match.status === 'void') return false
      await client.query(`UPDATE official_matches SET status='void',result=$2,finished_at=now() WHERE id=$1`, [id, { reason: reason.trim(), administrator: true }])
      await client.query('DELETE FROM official_claims WHERE match_id=$1', [id])
      await client.query('INSERT INTO official_audit(action,detail) VALUES($1,$2)', ['void-match', { value: id, reason: reason.trim() }])
      return false
    })
    if (ended) {
      await this.settle(id); await this.lifecycle.dispose(id)
      await this.pool.query('UPDATE official_matches SET actor_closed=TRUE WHERE id=$1', [id])
      throw new OfficialError('对局已结束，保留正常结算，不能作废', 409)
    }
    await this.lifecycle.dispose(id)
    await this.pool.query('UPDATE official_matches SET actor_closed=TRUE WHERE id=$1', [id])
  }
  async prepareShutdown() {
    await transaction(this.pool, async client => {
      await this.lock(client)
      if ((await client.query(`SELECT 1 FROM official_matches WHERE status='assigned' LIMIT 1`)).rowCount) throw new OfficialError('尚有比赛未完成，请先开启维护并等待比赛结束')
      await client.query('UPDATE official_settings SET maintenance=TRUE')
      await client.query(`INSERT INTO official_audit(action,detail) VALUES('stop','{}')`)
    })
    this.stopping = true
  }
}
