import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { request as httpRequest } from 'node:http'
import { EmbeddedPostgresController } from '../../electron-client/embedded-postgres'
import { findFreePort } from '../../electron-client/local-port'
import { createOfficialServer } from '@/lib/server/official/server'
import { startControlPanel } from '@/lib/server/official/control-panel'

describe.skipIf(process.platform !== 'win32')('local operations with actual PostgreSQL', () => {
  let app: Awaited<ReturnType<typeof createOfficialServer>>, panel: Awaited<ReturnType<typeof startControlPanel>>, pg: EmbeddedPostgresController, origin: string, token: string
  const shutdown = vi.fn(async () => {}), verify = vi.fn(async () => true)
  const mail = { status: () => ({ host: 'smtp.example.test', port: 465, sent: 0, failed: 0, checkedAt: null, connected: null, lastSentAt: null, lastFailedAt: null }), verify }
  async function request(route: string, data?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(origin + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, Origin: origin, 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) })
    return { status: response.status, text: await response.text() }
  }
  beforeAll(async () => {
    pg = new EmbeddedPostgresController({ runtimeRoot: path.resolve('_client-postgres/pgsql'), stateRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-panel-test-')), findFreePort, portHint: 38961, protectSecret: v => Buffer.from(v), unprotectSecret: v => v.toString() })
    const db = await pg.start(); app = await createOfficialServer({ databaseUrl: db.url, mail: async () => {} })
    const port = await findFreePort(38962); await app.start(port)
    panel = await startControlPanel({ ranked: app.ranked, mail, assetsRoot: path.resolve('lib/server/official/panel'), pagesRoot: path.resolve('data/pages'), playerPort: port, shutdown })
    const parsed = new URL(panel.url); origin = parsed.origin; token = parsed.hash.slice(1)
    await app.pool.query(`INSERT INTO official_accounts(id,email,name,password_hash) VALUES('panel-a','secret@example.test','面板测试甲','never-return-password-hash'),('panel-b','peer@example.test','面板测试乙','never-return-password-hash')`)
    await app.pool.query(`INSERT INTO official_sessions(token_hash,account_id) VALUES('never-return-session-token','panel-a')`)
  }, 90000)
  afterAll(async () => { await panel?.close(); await app?.close(); await pg?.stop() }, 30000)

  it('rejects missing, malformed, cross-origin, rebinding and oversized requests; assets never embed the capability', async () => {
    expect((await request('/api/snapshot', undefined, { Authorization: '' })).status).toBe(403)
    expect((await request('/api/snapshot', undefined, { Authorization: 'Bearer ' + 'é'.repeat(43) })).status).toBe(403)
    expect((await request('/api/snapshot', undefined, { Origin: 'https://foreign.test' })).status).toBe(403)
    // Node fetch normalizes Host; use a real raw HTTP request for rebinding coverage.
    const hostStatus = await new Promise(resolve => { const req = httpRequest(origin + '/api/snapshot', { headers: { Host: 'foreign.test', Authorization: 'Bearer ' + token } }, res => { res.resume(); resolve(res.statusCode) }); req.end() })
    expect(hostStatus).toBe(403)
    expect((await request('/api/action', { action: 'maintenance', value: 'on' }, { Origin: '' })).status).toBe(403)
    expect((await request('/api/action', { action: 'maintenance', value: 'x'.repeat(9000) })).status).toBe(413)
    const page = await fetch(origin); expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await page.text()).not.toContain(token)
    for (const file of ['/panel.js', '/panel.css', '/font.ttf', '/wood.svg']) expect((await fetch(origin + file)).ok).toBe(true)
    expect((await request('/official-config.json')).status).toBe(404)
  })
  it('shows real counts, masks account email and never exposes stored credentials', async () => {
    const snapshot = JSON.parse((await request('/api/snapshot')).text)
    expect(snapshot.counts.accounts).toBe(2); expect(snapshot.runtime.database).toBe('connected'); expect(snapshot.connections).toBe(0)
    const response = await request('/api/accounts?q=secret%40example.test')
    expect(JSON.parse(response.text).rows).toHaveLength(1); expect(response.text).toContain('s***@example.test')
    for (const value of ['secret@example.test', 'password_hash', 'never-return', 'token_hash']) expect(response.text).not.toContain(value)
    expect(JSON.parse((await request('/api/accounts?q=' + encodeURIComponent("' OR 1=1 --"))).text).rows).toHaveLength(0)
  })
  it('revokes a banned session and queue; rejects nonexistent targets and duplicate seasons without leaking SQL', async () => {
    await app.ranked.enqueue('panel-a', getServerGameProfileIdentityV1())
    expect((await request('/api/action', { action: 'ban', value: 'panel-a' })).status).toBe(200)
    expect((await app.pool.query("SELECT 1 FROM official_sessions WHERE account_id='panel-a'")).rowCount).toBe(0)
    expect((await app.pool.query("SELECT 1 FROM official_queue WHERE account_id='panel-a'")).rowCount).toBe(0)
    expect((await request('/api/action', { action: 'ban', value: 'missing' })).status).toBe(400)
    expect((await request('/api/action', { action: 'unban', value: 'panel-a' })).status).toBe(200)
    expect((await request('/api/action', { action: 'maintenance', value: 'on' })).status).toBe(200)
    expect((await request('/api/action', { action: 'season', value: 'panel-season' })).status).toBe(200)
    const duplicate = await request('/api/action', { action: 'season', value: 'panel-season' }); expect(duplicate.status).toBe(503); expect(duplicate.text).not.toContain('official_seasons')
    expect(JSON.parse((await request('/api/audit')).text).rows.map((r: { action: string }) => r.action)).toEqual(['season', 'maintenance', 'unban', 'ban'])
  })
  it('manages eligibility, cooldown, capacity, announcements and abnormal assignments without editing Elo', async () => {
    expect((await request('/api/action', { action: 'capacity', value: '3' })).status).toBe(400)
    expect((await request('/api/action', { action: 'capacity', value: '51', reason: 'invalid' })).status).toBe(400)
    expect((await request('/api/action', { action: 'capacity', value: '3', reason: '扩展试玩' })).status).toBe(200)
    expect(app.ranked.health().maxMatches).toBe(3)
    await app.ranked.initialize(); expect(app.ranked.maxMatches).toBe(3)
    expect((await request('/api/action', { action: 'rank-disable', value: 'panel-a', reason: '待审核' })).status).toBe(200)
    await expect(app.ranked.enqueue('panel-a', getServerGameProfileIdentityV1())).rejects.toThrow('排位资格')
    expect((await request('/api/action', { action: 'rank-enable', value: 'panel-a', reason: '审核通过' })).status).toBe(200)
    await app.pool.query("INSERT INTO official_cooldowns VALUES('panel-a',now()+interval '1 hour')")
    expect((await request('/api/action', { action: 'cooldown-clear', value: 'panel-a', reason: '网络测试' })).status).toBe(200)
    expect((await app.pool.query("SELECT 1 FROM official_cooldowns WHERE account_id='panel-a'")).rowCount).toBe(0)
    const announcement = '<script>untrusted</script>\n维护公告'
    expect((await request('/api/action', { action: 'announcement', value: announcement, reason: '通知试玩' })).status).toBe(200)
    expect(JSON.parse((await request('/api/snapshot')).text).settings.announcement).toBe(announcement)
    expect((await request('/api/action', { action: 'rating', value: '9999', reason: 'unsupported' })).status).toBe(400)
    await app.pool.query(`INSERT INTO official_matches(id,season_id,first_id,second_id) VALUES('abnormal','panel-season','panel-a','panel-b'); INSERT INTO official_claims VALUES('panel-a','abnormal'),('panel-b','abnormal')`)
    expect((await request('/api/action', { action: 'void-match', value: 'abnormal', reason: '测试异常清理' })).status).toBe(200)
    expect((await request('/api/action', { action: 'void-match', value: 'abnormal', reason: '重复请求' })).status).toBe(200)
    expect((await app.pool.query("SELECT 1 FROM official_claims WHERE match_id='abnormal'")).rowCount).toBe(0)
    expect((await app.pool.query("SELECT 1 FROM official_ratings WHERE account_id='panel-a'")).rowCount).toBe(0)
    expect((await app.pool.query("SELECT count(*)::int n FROM official_audit WHERE action='void-match' AND detail->>'value'='abnormal'")).rows[0].n).toBe(1)
  })
  it('sanitizes SMTP provider errors, rate limits checks and does not send messages', async () => {
    verify.mockRejectedValueOnce(new Error('SMTP secret credential recipient@example.test'))
    const result = await request('/api/action', { action: 'mail-check' }); expect(result.status).toBe(503); expect(result.text).not.toContain('secret'); expect(result.text).not.toContain('recipient')
    expect((await request('/api/action', { action: 'mail-check' })).status).toBe(429)
    expect(verify).toHaveBeenCalledTimes(1)
  })
  it('refuses season change and shutdown during a match; safely stops only after finalization and blocks later actions', async () => {
    await app.pool.query(`INSERT INTO official_matches(id,season_id,first_id,second_id) VALUES('panel-match','panel-season','panel-a','panel-b')`)
    expect((await request('/api/action', { action: 'season', value: 'blocked-season' })).status).toBe(400)
    expect((await request('/api/action', { action: 'stop' })).status).toBe(400); expect(shutdown).not.toHaveBeenCalled()
    const listing = await request('/api/matches'); expect(listing.text).toContain('面板测试甲'); expect(listing.text).not.toContain('checkpoint')
    await app.pool.query(`UPDATE official_matches SET status='void',finished_at=now() WHERE id='panel-match'`)
    const prepare = app.ranked.prepareShutdown.bind(app.ranked)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
    const spy = vi.spyOn(app.ranked, 'prepareShutdown').mockImplementationOnce(async () => { entered(); await gate; await prepare() })
    const controller = new AbortController()
    const stopping = fetch(origin + '/api/action', { method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }), signal: controller.signal }).catch(() => {})
    await ready; controller.abort(); await stopping; release()
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
    spy.mockRestore()
    expect((await request('/api/action', { action: 'maintenance', value: 'off' })).status).toBe(503)
    await expect(app.ranked.administer('maintenance', 'off')).rejects.toThrow('正在停止')
    expect((await app.pool.query('SELECT maintenance FROM official_settings')).rows[0].maintenance).toBe(true)
  })
})
