import { afterAll, beforeAll, expect, it, vi, describe } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { matchMaker } from 'colyseus'
import { Client, type Room } from '@colyseus/sdk'
import { EmbeddedPostgresController } from '../../electron-client/embedded-postgres'
import { findFreePort } from '../../electron-client/local-port'
import { createOfficialServer } from '@/lib/server/official/server'
import { digest } from '@/lib/server/official/accounts'
import { eloChange } from '@/lib/server/official/ranked'
import { getBattleStorage } from '@/lib/game/battle-storage'
import { roomAuthorityQueue } from '@/lib/game/room-authority-queue'
import type { CandidateBattleStore } from '@/lib/server/colyseus/candidate-battle-store'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import type { PublicBattleSnapshot } from '@/lib/game/room-battle-actions'
import { BATTLE_AUTHORITY_BUILD_ID, BATTLE_AUTHORITY_PROTOCOL_VERSION } from '@/lib/game/battle-public-patch'

describe.skipIf(process.platform !== 'win32')('Windows embedded PostgreSQL official integration', () => {
let databaseUrl: string
let app: Awaited<ReturnType<typeof createOfficialServer>>, pg: EmbeddedPostgresController, root: string, url: string
const mail = new Map<string, string>(), clients: Room[] = []
const profileIdentity = getServerGameProfileIdentityV1()
type User = { token: string; account: { id: string; name: string; email: string } }
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-official-test-'))
  pg = new EmbeddedPostgresController({ runtimeRoot: path.resolve('_client-postgres/pgsql'), stateRoot: root, findFreePort, portHint: 38931,
    protectSecret: value => Buffer.from(value), unprotectSecret: value => value.toString(),
  })
  const connection = await pg.start()
  databaseUrl = connection.url
  app = await createOfficialServer({ databaseUrl: connection.url, mail: async (to: string, purpose: string, code: string) => { mail.set(`${to}:${purpose}`, code) }, maxMatches: 2, reconnectGraceMs: 5000, adminToken: 'a'.repeat(43) })
  const port = await findFreePort(38932); url = `http://127.0.0.1:${port}`
  await app.start(port)
}, 90000)
afterAll(async () => {
  for (const client of clients) if (client.connection.isOpen) await client.leave()
  await app?.close(); await pg?.stop()
  // Keep the uniquely named evidence database for failure diagnosis; never delete a user's database.
}, 30000)
async function http(route: string, body?: unknown, token?: string) {
  const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
async function user(): Promise<User> {
  const email = `${randomUUID()}@example.test`, password = 'A-test-password-123!'
  expect((await http('/official/auth/register', { email, password, name: '测试玩家' })).status).toBe(200)
  expect((await http('/official/auth/verify', { email, code: mail.get(`${email}:verify`) })).status).toBe(200)
  const result = await http('/official/auth/login', { email, password })
  expect(result.status).toBe(200)
  return result.body as User
}
async function matched(first: User, second: User) {
  await app.ranked.enqueue(first.account.id, profileIdentity); await app.ranked.enqueue(second.account.id, profileIdentity)
  for (let i = 0; i < 50; i++) { await app.ranked.tick(); const status = await app.ranked.status(first.account.id); if (status.matchId) {
    // RC4 assigned-room compatibility fixture. New preparation is covered by the pregame integration cases.
    await app.pool.query('DELETE FROM official_pregames WHERE match_id=$1', [status.matchId])
    await matchMaker.createRoom('battle', { product: true, mode: '1v1', battleId: status.matchId, playerId: first.account.id, officialCapability: app.ranked.capability, mapId: 'open-expanse', name: 'Legacy assigned fixture' })
    return status.matchId as string
  }; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('No ranked match assigned')
}
async function join(user: User, roomId: string) {
  const room = await new Client(url).joinById(roomId, { playerId: user.account.id, officialToken: user.token, alignment: 'light', profileIdentity })
  room.onMessage('*', () => {}); clients.push(room); return room
}
async function snapshot(room: Room): Promise<PublicBattleSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('snapshot timeout')) }, 6000)
    const off = room.onMessage<PublicBattleSnapshot>('battleSnapshot', data => { clearTimeout(timer); off(); resolve(data) })
    room.send('battleResync', {})
  })
}
async function finish(first: User, second: User, id: string) {
  const a = await join(first, id), b = await join(second, id)
  const pieces = getDemoPieceIds().map(id => getPieceById(id)!).filter(p => p.faction === 'good').slice(0, 8).map(p => ({ templateId: p.id, faction: p.faction }))
  for (const [room, user] of [[a, first], [b, second]] as const) await room.request('roomRpc', { method: 'rooms.action', data: { action: 'select-pieces', playerId: user.account.id, alignment: 'light', pieces, profileIdentity } })
  const view = await snapshot(a)
  const receipt = new Promise(resolve => a.onMessage('battleReceipt', resolve))
  const actionId = randomUUID()
  a.send('battleCommand', { protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION, authorityBuildId: BATTLE_AUTHORITY_BUILD_ID, roomId: id, playerId: first.account.id, expectedAuthorityVersion: view.authorityVersion, clientActionId: actionId, command: { type: 'surrender', playerId: first.account.id, clientActionId: actionId } })
  expect(await receipt).toMatchObject({ kind: 'applied' })
  return { a, b }
}

it('registers only after email proof; codes expire/are single use; resetting password revokes sessions', async () => {
  const email = `${randomUUID()}@example.test`, password = 'Test-password-123!'
  expect((await http('/official/auth/login', { email, password })).status).toBe(401)
  expect((await http('/official/auth/register', { email, password, name: '邮箱验证' })).status).toBe(200)
  expect((await http('/official/auth/login', { email, password })).status).toBe(401)
  const code = mail.get(`${email}:verify`)!
  expect((await http('/official/auth/verify', { email, code: 'wrong' })).status).toBe(400)
  expect((await http('/official/auth/verify', { email, code })).status).toBe(200)
  expect((await http('/official/auth/verify', { email, code })).status).toBe(400)
  const login = await http('/official/auth/login', { email, password })
  expect(login.status).toBe(200)
  const stored = (await app.pool.query('SELECT password_hash FROM official_accounts WHERE email=$1', [email])).rows[0]
  expect(stored.password_hash).not.toContain(password)
  expect((await app.pool.query('SELECT token_hash FROM official_sessions WHERE account_id=$1', [login.body.account.id])).rows[0].token_hash).toBe(digest(login.body.token))
  await app.pool.query('DELETE FROM official_rate_limits')
  expect((await http('/official/auth/forgot', { email })).status).toBe(200)
  const reset = mail.get(`${email}:reset`)!
  expect((await http('/official/auth/reset', { email, code: reset, password: 'New-password-123!' })).status).toBe(200)
  expect((await http('/official/me', undefined, login.body.token)).status).toBe(401)
  expect((await http('/official/auth/login', { email, password })).status).toBe(401)
  expect((await http('/official/auth/login', { email, password: 'New-password-123!' })).status).toBe(200)
}, 30000)

it('uses only server assignments; arbitrary-Elo players finish a real Colyseus battle and settle exactly once from the durable terminal', async () => {
  await app.pool.query('DELETE FROM official_rate_limits')
  const first = await user(), second = await user(), outsider = await user()
  await app.pool.query(`INSERT INTO official_ratings(season_id,account_id,rating) VALUES('test-1',$1,2200)`, [second.account.id])
  await expect(new Client(url).create('battle', { product: true, playerId: first.account.id, officialToken: first.token })).rejects.toThrow()
  const id = await matched(first, second)
  await expect(app.ranked.enqueue(first.account.id, profileIdentity)).rejects.toThrow('当前比赛')
  await expect(new Client(url).joinById(id, { playerId: first.account.id, officialToken: outsider.token, profileIdentity })).rejects.toThrow()
  await expect(new Client(url).joinById(id, { playerId: outsider.account.id, officialToken: outsider.token, profileIdentity })).rejects.toThrow()
  expect(await app.ranked.settle(id)).toBe(false)
  const { a, b } = await finish(first, second, id)
  await Promise.all([app.ranked.settle(id), app.ranked.settle(id), app.ranked.settle(id)])
  const record = (await app.pool.query('SELECT * FROM official_matches WHERE id=$1', [id])).rows[0]
  expect(record.status).toBe('settled')
  expect(record.result.winnerId).toBe(second.account.id)
  expect(record.result.first.delta + record.result.second.delta).toBe(0)
  expect((await app.ranked.status(first.account.id)).rating.games).toBe(1)
  expect((await app.ranked.status(second.account.id)).rating.games).toBe(1)
  expect((await app.ranked.status(first.account.id)).matchId).toBeNull()
  expect(await app.ranked.settle('p2p-untrusted-result')).toBe(false)
  expect((await http('/battle-reports/' + id, undefined, outsider.token)).status).toBe(403)
  expect((await http('/battle-reports/' + id, undefined, first.token)).status).toBe(200)
  await a.leave(); await b.leave()
}, 45000)

it('cancels leases, enforces room capacity, deduplicates long drops and preserves historical ratings on season change', async () => {
  await app.pool.query('DELETE FROM official_rate_limits')
  const players = [await user(), await user(), await user(), await user(), await user(), await user()]
  await app.ranked.enqueue(players[0].account.id, profileIdentity); await app.ranked.cancel(players[0].account.id)
  expect((await app.ranked.status(players[0].account.id)).queued).toBe(false)
  const a = await matched(players[0], players[1]), b = await matched(players[2], players[3])
  await app.ranked.enqueue(players[4].account.id, profileIdentity); await app.ranked.enqueue(players[5].account.id, profileIdentity)
  await app.ranked.tick()
  expect((await app.ranked.status(players[4].account.id)).matchId).toBeNull()
  await app.ranked.longDrop(a, players[0].account.id); await app.ranked.longDrop(a, players[0].account.id)
  expect(Number((await app.pool.query('SELECT count(*) FROM official_drops WHERE match_id=$1', [a])).rows[0].count)).toBe(1)
  await expect(app.ranked.administer('season', 'season-1')).rejects.toThrow('比赛未完成')
  // Setup expiry must release both assigned accounts, without granting Elo.
  await app.pool.query(`UPDATE official_matches SET created_at=now()-interval '4 minutes' WHERE id=ANY($1)`, [[a, b]])
  await app.ranked.administer('maintenance', 'on'); await app.ranked.tick()
  expect((await app.ranked.status(players[0].account.id)).matchId).toBeNull()
  expect((await app.ranked.status(players[0].account.id)).rating.games).toBe(0)
  expect((await app.pool.query('SELECT status FROM official_matches WHERE id=$1', [a])).rows[0].status).toBe('void')
  await app.ranked.administer('season', 'season-1')
  expect((await app.ranked.status(players[1].account.id)).rating.rating).toBe(1000)
  expect((await app.pool.query(`SELECT count(*) FROM official_matches WHERE status='settled'`)).rows[0].count).toBe('1')
  expect((await app.ranked.leaderboard())).toEqual([])
}, 45000)

it('calculates symmetric Elo including draws and unequal ratings', () => {
  expect(eloChange(1000, 1000, 1)).toBe(16)
  expect(eloChange(1000, 1000, 0)).toBe(-16)
  expect(eloChange(1000, 1000, 0.5)).toBe(0)
  expect(eloChange(1000, 1400, 1)).toBeGreaterThan(16)
  expect(eloChange(1400, 1000, 0)).toBeLessThan(-16)
})


it('rejects malformed administrator tokens without losing the server and validates maintenance commands', async () => {
  expect((await http('/official/admin', { action: 'maintenance', value: 'on' }, 'é'.repeat(43))).status).toBe(403)
  expect((await http('/official/info')).status).toBe(200)
  expect((await http('/official/admin', { action: 'maintenance', value: 'garbage' }, 'a'.repeat(43))).status).toBe(400)
  expect((await http('/official/admin', { action: 'maintenance', value: 'off' }, 'a'.repeat(43))).status).toBe(200)
})

it('reclaims a disconnected revoked session immediately and keeps a valid session on a temporary database failure', async () => {
  await app.pool.query('DELETE FROM official_rate_limits')
  await app.ranked.administer('maintenance', 'off')
  const first = await user(), second = await user(), id = await matched(first, second)
  const old = await join(first, id)
  const actor = matchMaker.getLocalRoomById(id) as unknown as { clients: unknown[]; closeOfficialMatch(onlyIfUnstarted?: boolean): Promise<boolean> }
  old.reconnection.enabled = false; old.connection.close()
  await vi.waitFor(() => expect(actor.clients).toHaveLength(0), { timeout: 2000 })
  const replacement = await http('/official/auth/login', { email: first.account.email, password: 'A-test-password-123!' })
  expect(replacement.status).toBe(200)
  const current = await join(replacement.body, id)
  await expect(join(replacement.body, id)).rejects.toThrow('already connected')
  const auth = vi.spyOn(app.accounts, 'authenticate').mockRejectedValue(new Error('temporary database outage'))
  try { await expect(current.request('roomRpc', { method: 'rooms.get', data: { roomId: id } })).rejects.toThrow() }
  finally { auth.mockRestore() }
  expect(current.connection.isOpen).toBe(true)
  expect(await current.request('roomRpc', { method: 'rooms.get', data: { roomId: id } })).toMatchObject({ id })
  await current.leave()
  await actor.closeOfficialMatch(true)
  await app.pool.query("UPDATE official_matches SET created_at=now()-interval '4 minutes' WHERE id=$1", [id])
  await app.ranked.tick()
}, 30000)

it('email expiry and exhausted attempt limits cannot create accounts', async () => {
  await app.pool.query('DELETE FROM official_rate_limits')
  for (const expired of [true, false]) {
    const email = `${randomUUID()}@example.test`
    await app.accounts.requestCode('verify', { email, password: 'Test-password-123!', name: '验证边界' })
    if (expired) await app.pool.query("UPDATE official_email_codes SET expires_at=now()-interval '1 second' WHERE email=$1", [email])
    else for (let n = 0; n < 5; n++) await expect(app.accounts.redeem('verify', { email, code: 'wrong' })).rejects.toThrow()
    await expect(app.accounts.redeem('verify', { email, code: mail.get(`${email}:verify`) })).rejects.toThrow()
    expect((await app.pool.query('SELECT id FROM official_accounts WHERE email=$1', [email])).rowCount).toBe(0)
  }
}, 15000)


it('does not cancel a concurrently starting game; refuses missing authority on restart; restores and settles a match once', async () => {
  await app.pool.query('DELETE FROM official_rate_limits')
  await app.ranked.administer('maintenance', 'off')
  const first = await user(), second = await user(), id = await matched(first, second)
  const a = await join(first, id), b = await join(second, id)
  const pieces = getDemoPieceIds().map(id => getPieceById(id)!).filter(p => p.faction === 'good').slice(0, 8).map(p => ({ templateId: p.id, faction: p.faction }))
  await a.request('roomRpc', { method: 'rooms.action', data: { action: 'select-pieces', playerId: first.account.id, alignment: 'light', pieces, profileIdentity } })
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), initialized = new Promise<void>(resolve => { entered = resolve })
  const initialize = app.repository.initializeRoom.bind(app.repository)
  const spy = vi.spyOn(app.repository, 'initializeRoom').mockImplementationOnce(async (...args) => { entered(); await held; return initialize(...args) })
  const preparing = b.request('roomRpc', { method: 'rooms.action', data: { action: 'select-pieces', playerId: second.account.id, alignment: 'light', pieces, profileIdentity } })
  await initialized
  const actor = matchMaker.getLocalRoomById(id) as unknown as { closeOfficialMatch(onlyIfUnstarted?: boolean): Promise<boolean> }
  const closing = actor.closeOfficialMatch(true)
  release()
  try { await preparing; expect(await closing).toBe(false) } finally { spy.mockRestore() }
  expect((await snapshot(a)).authorityVersion).toBeGreaterThanOrEqual(0)
  await a.leave(); await b.leave(); await app.close()
  const port = Number(new URL(url).port), options = { databaseUrl, mail: async (to: string, purpose: string, code: string) => { mail.set(`${to}:${purpose}`, code) }, reconnectGraceMs: 5000 }
  app = await createOfficialServer(options)
  const restore = app.repository.restoreRoom.bind(app.repository)
  const failed = vi.spyOn(app.repository, 'restoreRoom').mockImplementation(async battleId => { if (battleId === id) throw new Error('injected restore failure'); return restore(battleId) })
  await expect(app.start(port)).rejects.toThrow('未成功恢复')
  failed.mockRestore(); await app.close()
  app = await createOfficialServer(options); await app.start(port)
  const resumed = await join(first, id), peer = await join(second, id), view = await snapshot(resumed), actionId = randomUUID()
  const receipt = new Promise(resolve => resumed.onMessage('battleReceipt', resolve))
  resumed.send('battleCommand', { protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION, authorityBuildId: BATTLE_AUTHORITY_BUILD_ID, roomId: id, playerId: first.account.id, expectedAuthorityVersion: view.authorityVersion, clientActionId: actionId, command: { type: 'surrender', playerId: first.account.id, clientActionId: actionId } })
  expect(await receipt).toMatchObject({ kind: 'applied' })
  await app.ranked.settle(id)
  await resumed.leave(); await peer.leave(); await app.close()
  app = await createOfficialServer(options); await app.start(port)
  expect(await app.ranked.settle(id)).toBe(false)
  const restoredCatalog = await http('/rooms')
  expect(restoredCatalog.body.rooms).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]))
  const restoredDetail = await http('/rooms/' + id)
  // Completed actors are not restored after restart; durable reports remain available.
  expect(restoredDetail.status).toBe(404)
  expect((await http('/battle-reports/' + id, undefined, first.token)).status).toBe(200)
  expect((await app.ranked.status(first.account.id)).rating.games).toBe(1)
  const historical = (await app.pool.query("SELECT first_id FROM official_matches WHERE season_id='test-1' AND status='settled' LIMIT 1")).rows[0]
  expect((await app.ranked.status(historical.first_id)).testParticipant).toBe(true)
}, 60000)


it('administrator kick immediately disconnects the SDK session and permits a fresh login to reclaim its seat', async () => {
  await app.pool.query('DELETE FROM official_rate_limits'); await app.ranked.administer('maintenance', 'off')
  const first = await user(), second = await user(), id = await matched(first, second)
  const a = await join(first, id)
  await app.ranked.administer('kick', first.account.id, '测试踢人')
  await vi.waitFor(() => expect(a.connection.isOpen).toBe(false))
  expect((await http('/official/me', undefined, first.token)).status).toBe(401)
  const login = await http('/official/auth/login', { email: first.account.email, password: 'A-test-password-123!' })
  expect(login.status).toBe(200); first.token = login.body.token
  const rejoined = await join(first, id); expect(rejoined.connection.isOpen).toBe(true)
  await app.ranked.administer('void-match', id, '清理准备阶段测试')
  await vi.waitFor(() => expect(rejoined.connection.isOpen).toBe(false))
}, 25000)

it('freezes live authority before voiding, rejects queued writes, preserves Elo and never restores the void actor', async () => {
  await app.pool.query('DELETE FROM official_rate_limits'); await app.ranked.administer('maintenance', 'off')
  const first = await user(), second = await user(), id = await matched(first, second)
  const a = await join(first, id), b = await join(second, id)
  const pieces = getDemoPieceIds().map(id => getPieceById(id)!).filter(p => p.faction === 'good').slice(0, 8).map(p => ({ templateId: p.id, faction: p.faction }))
  for (const [room, user] of [[a, first], [b, second]] as const) await room.request('roomRpc', { method: 'rooms.action', data: { action: 'select-pieces', playerId: user.account.id, alignment: 'light', pieces, profileIdentity } })
  const actor = matchMaker.getLocalRoomById(id) as unknown as { authorityStore: CandidateBattleStore; freezeOfficialMatch(): Promise<void> }
  const store = actor.authorityStore, old = (await store.getRoom(id))!
  let release!: () => void
  const holding = roomAuthorityQueue.enqueue(id, { kind: 'system' }, () => new Promise<void>(resolve => { release = resolve }))
  const frozen = actor.freezeOfficialMatch()
  const blocked = ['player', 'timer', 'bot'].map(() => roomAuthorityQueue.enqueue(id, { kind: 'system' }, () => store.setRoom(id, old)).then(() => false, () => true))
  release(); await holding; await frozen
  expect(await Promise.all(blocked)).toEqual([true, true, true])
  await app.ranked.administer('void-match', id, '卡住的测试对局')
  await vi.waitFor(() => { expect(a.connection.isOpen).toBe(false); expect(b.connection.isOpen).toBe(false) })
  expect((await app.ranked.status(first.account.id)).matchId).toBeNull()
  expect((await app.ranked.status(first.account.id)).rating.games).toBe(0)
  await expect(store.setRoomIfVersion(id, old, old.version ?? 0)).rejects.toThrow('管理员关闭')
  expect(await app.ranked.settle(id)).toBe(false)
  await app.close(); app = await createOfficialServer({ databaseUrl, mail: async (to: string, purpose: string, code: string) => { mail.set(`${to}:${purpose}`, code) } }); await app.start(Number(new URL(url).port))
  expect(matchMaker.getLocalRoomById(id)).toBeUndefined()
  expect((await http('/rooms/' + id)).status).toBe(404)
  expect((await app.pool.query('SELECT status FROM official_matches WHERE id=$1', [id])).rows[0].status).toBe('void')
  await expect(app.ranked.authorize(id, first.account.id, first.token)).rejects.toThrow('取消')
}, 40000)

it('preserves normal terminal settlement when an administrator attempts to void an ended match', async () => {
  await app.pool.query('DELETE FROM official_rate_limits')
  const first = await user(), second = await user(), id = await matched(first, second)
  await finish(first, second, id)
  await expect(app.ranked.administer('void-match', id, '晚到的异常报告')).rejects.toThrow(/已结算|已结束/)
  await app.ranked.settle(id)
  expect((await app.ranked.status(first.account.id)).rating.games).toBe(1)
  expect((await app.pool.query('SELECT status FROM official_matches WHERE id=$1', [id])).rows[0].status).toBe('settled')
}, 30000)

async function matchedPregame(first: User, second: User) {
  await app.ranked.enqueue(first.account.id, profileIdentity); await app.ranked.enqueue(second.account.id, profileIdentity)
  for (let i = 0; i < 50; i++) { await app.ranked.tick(); const status = await app.ranked.status(first.account.id); if (status.matchId) return status.matchId; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Pregame not assigned')
}
it('runs sealed veto and original progressive deployment on all four ranked maps; pool changes affect only future matches', async () => {
  await app.pool.query('DELETE FROM official_rate_limits')
  const maps = ['large-hole-arena', 'open-expanse', 'winding-pass', 'narrow-corridors']
  const first = await user(), second = await user(), outsider = await user()
  const ids = getDemoPieceIds().filter(id => getPieceById(id)?.faction === 'good').slice(0,8)
  expect((await http('/official/queue/join', {}, first.token)).status).toBe(409)
  await expect(app.ranked.enqueue(first.account.id, {...profileIdentity,runnerRevision:'wrong'})).rejects.toThrow('版本')
  for (const selected of maps) {
    const banned = maps.filter(id => id !== selected).slice(0,2), pool = [selected,...banned]
    await app.ranked.administer('map-pool',JSON.stringify(pool),'地图适配测试')
    const id = await matchedPregame(first,second)
    expect(matchMaker.getLocalRoomById(id)).toBeUndefined()
    expect((await http('/official/pregame/'+id,undefined,outsider.token)).status).toBe(403)
    await app.ranked.administer('map-pool',JSON.stringify(maps),'新比赛地图池')
    const a = await http('/official/pregame/'+id,{action:'ban',mapId:banned[0]},first.token)
    expect(a.status).toBe(200); expect(a.body.maps).toHaveLength(3)
    const hidden = (await http('/official/pregame/'+id,undefined,second.token)).body
    expect(hidden.players.find((p: {id:string})=>p.id===first.account.id).ban).toBeNull()
    expect(hidden).not.toHaveProperty('seed')
    const reveal = await http('/official/pregame/'+id,{action:'ban',mapId:banned[1]},second.token)
    expect(reveal.body.mapId).toBe(selected)
    for (const user of [first,second]) expect((await http('/official/pregame/'+id,{action:'lock',revision:0,alignment:'light',pieces:ids},user.token)).status).toBe(200)
    for (let i=0;i<30;i++) { await app.ranked.tick(); if ((await app.ranked.preparation(id,first.account.id)).phase==='battle') break; await new Promise(resolve=>setTimeout(resolve,100)) }
    expect((await app.ranked.preparation(id,first.account.id)).phase).toBe('battle')
    const persisted = (await app.pool.query('SELECT 1 FROM battle_room_authority WHERE battle_id=$1',[id])).rowCount
    expect(persisted).toBe(1)
    const store = (matchMaker.getLocalRoomById(id) as unknown as { authorityStore: CandidateBattleStore }).authorityStore
    const room = await store.getRoom(id)
    expect(room?.mapId).toBe(selected)
    const socket = await join(first,id), view = await snapshot(socket)
    expect(view.state.deployment?.mode).toBe('progressive-reserve-v1')
    expect(view.state.pieces.length).toBeLessThan(16)
    await socket.leave()
    await expect(app.ranked.withdraw(id,first.account.id)).rejects.toThrow('已经开始')
    await app.ranked.administer('void-match',id,'完成地图适配测试')
  }
  await expect(app.ranked.administer('map-pool',JSON.stringify(maps.slice(0,2)),'非法地图池')).rejects.toThrow('至少3')
}, 90000)
it('restores sealed pregame deadlines and drafts, auto-fills after expiry, and rates explicit withdrawal once', async () => {
  await app.pool.query('DELETE FROM official_rate_limits')
  const first=await user(),second=await user(),id=await matchedPregame(first,second)
  await app.ranked.preparation(id,first.account.id,{action:'ban',mapId:'open-expanse'})
  await app.ranked.preparation(id,second.account.id,{action:'ban',mapId:'open-expanse'})
  const pieces=getDemoPieceIds().filter(id=>getPieceById(id)?.faction==='good').slice(0,2)
  const draft=await app.ranked.preparation(id,first.account.id,{action:'draft',revision:0,alignment:'light',pieces})
  await app.close();app=await createOfficialServer({databaseUrl,mail:async()=>{}});await app.start(Number(new URL(url).port))
  const restored=await app.ranked.preparation(id,first.account.id)
  expect(restored).toMatchObject({phase:'roster',deadlineAt:('deadlineAt' in draft ? draft.deadlineAt : 0)})
  expect('players' in restored && restored.players.find(p=>p.id===first.account.id)?.pieces).toEqual(pieces)
  await app.pool.query("UPDATE official_pregames SET state=jsonb_set(state,'{deadlineAt}',to_jsonb($2::bigint)) WHERE match_id=$1",[id,Date.now()-1])
  for(let i=0;i<30;i++){await app.ranked.tick();if((await app.ranked.preparation(id,first.account.id)).phase==='battle')break;await new Promise(resolve=>setTimeout(resolve,100))}
  const started=await app.ranked.preparation(id,first.account.id)
  expect(started.phase).toBe('battle');expect('players' in started && started.players.find(p=>p.id===first.account.id)?.pieces?.slice(0,2)).toEqual(pieces)
  // Model a crash after durable version zero but before the pregame phase acknowledgement.
  const before = await (matchMaker.getLocalRoomById(id) as unknown as {authorityStore:CandidateBattleStore}).authorityStore.getRoom(id)
  await app.pool.query(`UPDATE official_pregames SET state=jsonb_set(state,'{phase}','"starting"') WHERE match_id=$1`,[id])
  await app.close();app=await createOfficialServer({databaseUrl,mail:async()=>{}});await app.start(Number(new URL(url).port))
  const after = await (matchMaker.getLocalRoomById(id) as unknown as {authorityStore:CandidateBattleStore}).authorityStore.getRoom(id)
  expect(after?.mapId).toBe(before?.mapId)
  expect(after?.players.map(p=>p.selectedPieces)).toEqual(before?.players.map(p=>p.selectedPieces))
  expect(before).toBeTruthy(); expect(after).toBeTruthy()
  expect(getBattleStorage(before!)?.rootSeed).toEqual(expect.any(Number))
  expect(getBattleStorage(after!)?.rootSeed).toBe(getBattleStorage(before!)?.rootSeed)
  expect((await app.ranked.preparation(id,first.account.id)).phase).toBe('battle')
  expect((await app.pool.query('SELECT 1 FROM battle_room_authority WHERE battle_id=$1',[id])).rowCount).toBe(1)
  await app.ranked.administer('void-match',id,'超时启动验收')
  const exitId=await matchedPregame(first,second)
  await Promise.all([app.ranked.withdraw(exitId,first.account.id),app.ranked.withdraw(exitId,first.account.id),app.ranked.tick()])
  expect((await app.ranked.status(first.account.id)).rating).toMatchObject({games:1,rating:984})
  expect((await app.ranked.status(second.account.id)).rating).toMatchObject({games:1,rating:1016})
  expect((await app.pool.query('SELECT 1 FROM battle_terminal_barrier WHERE battle_id=$1',[exitId])).rowCount).toBe(0)
  expect((await app.ranked.status(first.account.id)).cooldownUntil).toBeTruthy()
  expect((await app.ranked.status(first.account.id)).matchId).toBeNull()
},60000)

it('releases the listener and pool even when the durability journal fails during shutdown', async () => {
  const failed = vi.spyOn(app.journal, 'close').mockRejectedValueOnce(new Error('injected durability failure'))
  try { await expect(app.close()).rejects.toThrow('落盘或关闭失败') } finally { failed.mockRestore() }
  await expect(fetch(url + '/official/info')).rejects.toThrow()
  expect(app.pool.totalCount).toBe(0)
  app = await createOfficialServer({ databaseUrl, mail: async (to: string, purpose: string, code: string) => { mail.set(`${to}:${purpose}`, code) } }); await app.start(Number(new URL(url).port))
}, 20000)

})
