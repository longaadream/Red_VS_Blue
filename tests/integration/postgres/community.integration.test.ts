import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { digest } from '@/lib/server/official/accounts'
import { startControlPanel } from '@/lib/server/official/control-panel'
import { createOfficialServer } from '@/lib/server/official/server'
import { findFreePort } from '@/electron-client/local-port'

const databaseUrl = process.env.RVB_TEST_POSTGRES_URL

type Actor = {
  id: string
  email: string
  name: string
  token: string
}

type HttpResult<T = Record<string, unknown>> = {
  status: number
  body: T
  text: string
}

type CommunityFriend = { id: string; name: string; online?: boolean }
type CommunityFriends = {
  friends: CommunityFriend[]
  incoming: Array<CommunityFriend & { createdAt: string }>
  outgoing: Array<CommunityFriend & { createdAt: string }>
  blocked: CommunityFriend[]
}

const suite = describe.skipIf(!databaseUrl)

suite('RED-242 official community against real PostgreSQL', () => {
  let app: Awaited<ReturnType<typeof createOfficialServer>> | undefined
  let basePool: Pool | undefined
  let scopedDatabaseUrl = ''
  let origin = ''
  let schema = ''
  let port = 0
  let adminSecret = ''

  beforeAll(async () => {
    schema = `red242_test_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    basePool = new Pool({ connectionString: databaseUrl!, max: 4 })
    await basePool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
    scopedDatabaseUrl = withSearchPath(databaseUrl!, schema)
    adminSecret = `red242-admin-${randomUUID()}`
    app = await createOfficialServer({
      databaseUrl: scopedDatabaseUrl,
      mail: async () => {},
      adminToken: adminSecret,
    })
    port = await findFreePort(39042)
    await app.start(port)
    origin = `http://127.0.0.1:${port}`
  }, 120_000)

  afterAll(async () => {
    await app?.close().catch(() => {})
    await basePool?.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => {})
    await basePool?.end().catch(() => {})
  }, 60_000)

  it('authenticates every route and keeps concurrent relationships, visibility, blocking, and presence consistent', async () => {
    const [alice, bob, outsider, carol, banned, rateLimited] = await seedActors('relationships', 6)

    expect((await request(undefined, '/official/community/accounts?q=Alice')).status).toBe(401)
    expect((await request(undefined, '/official/community/friends')).status).toBe(401)
    expect((await request(undefined, '/official/community/board')).status).toBe(401)
    expect((await request(undefined, '/official/community/heartbeat', {})).status).toBe(401)
    expect((await request(alice, '/official/community/friends/request', { targetAccountId: alice.id })).status).toBe(400)

    const search = await request<{ accounts: Array<Record<string, unknown>> }>(
      alice,
      `/official/community/accounts?q=${encodeURIComponent(alice.name)}`,
    )
    expect(search.status).toBe(200)
    expect(search.body.accounts).toEqual(expect.arrayContaining([{ id: alice.id, name: alice.name }]))
    expect(search.body.accounts.every(account => Object.keys(account).sort().join(',') === 'id,name')).toBe(true)
    expect(search.text).not.toContain('@')

    const [leftRequest, rightRequest] = await Promise.all([
      request(alice, '/official/community/friends/request', { targetAccountId: bob.id }),
      request(bob, '/official/community/friends/request', { targetAccountId: alice.id }),
    ])
    expect([leftRequest.status, rightRequest.status].some(status => status >= 200 && status < 300)).toBe(true)

    const alicePending = await request<CommunityFriends>(alice, '/official/community/friends')
    const bobPending = await request<CommunityFriends>(bob, '/official/community/friends')
    expect(alicePending.status).toBe(200)
    expect(bobPending.status).toBe(200)
    expect(alicePending.body.friends).toHaveLength(0)
    expect(bobPending.body.friends).toHaveLength(0)
    expect(pendingRepresentationCount(alicePending.body, bob.id) + pendingRepresentationCount(bobPending.body, alice.id)).toBe(2)

    const outsiderAccept = await request(outsider, '/official/community/friends/accept', { targetAccountId: alice.id })
    expect(outsiderAccept.status).toBeGreaterThanOrEqual(400)
    expect(outsiderAccept.body).toHaveProperty('error')

    const aliceIsRequester = alicePending.body.outgoing.some(friend => friend.id === bob.id)
    const recipient = aliceIsRequester ? bob : alice
    const requester = aliceIsRequester ? alice : bob
    const accepted = await request(recipient, '/official/community/friends/accept', { targetAccountId: requester.id })
    expect(accepted.status).toBe(200)

    await expect(request(recipient, '/official/community/friends/accept', { targetAccountId: requester.id })).resolves.toMatchObject({ status: expect.any(Number) })
    expect((await request(recipient, '/official/community/friends')).body.friends).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: requester.id, online: false }),
    ]))

    const heartbeat = await request(requester, '/official/community/heartbeat', {})
    expect(heartbeat.status).toBe(200)
    const onlineView = await request<CommunityFriends>(recipient, '/official/community/friends')
    expect(onlineView.body.friends).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: requester.id, online: true }),
    ]))

    await expirePresence(requester.id)
    const expiredView = await request<CommunityFriends>(recipient, '/official/community/friends')
    expect(expiredView.body.friends).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: requester.id, online: false }),
    ]))

    const block = await request(recipient, '/official/community/friends/block', { targetAccountId: requester.id })
    expect(block.status).toBe(200)
    const blockedView = await request<CommunityFriends>(recipient, '/official/community/friends')
    expect(blockedView.body.friends).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: requester.id })]))
    expect(blockedView.body.blocked).toEqual(expect.arrayContaining([expect.objectContaining({ id: requester.id })]))
    const blockedRequest = await request(requester, '/official/community/friends/request', { targetAccountId: recipient.id })
    expect(blockedRequest.status).toBeGreaterThanOrEqual(400)
    expect((await request(requester, '/official/community/friends')).body.friends).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: recipient.id }),
    ]))

    expect((await request(recipient, '/official/community/friends/unblock', { targetAccountId: requester.id })).status).toBe(200)
    expect((await request(alice, '/official/community/friends/request', { targetAccountId: carol.id })).status).toBe(200)
    expect((await request(carol, '/official/community/friends/reject', { targetAccountId: alice.id })).status).toBe(200)
    expect((await request(bob, '/official/community/friends/request', { targetAccountId: carol.id })).status).toBe(200)
    expect((await request(bob, '/official/community/friends/withdraw', { targetAccountId: carol.id })).status).toBe(200)
    expect((await request(requester, '/official/community/friends/request', { targetAccountId: recipient.id })).status).toBe(200)
    expect((await request(recipient, '/official/community/friends/accept', { targetAccountId: requester.id })).status).toBe(200)
    expect((await request(requester, '/official/community/friends/remove', { targetAccountId: recipient.id })).status).toBe(200)
    await app!.pool.query('UPDATE official_accounts SET banned=TRUE WHERE id=$1', [banned.id])
    expect((await request(banned, '/official/community/friends')).status).toBe(401)
    const bannedTargetRequest = await request(alice, '/official/community/friends/request', { targetAccountId: banned.id })
    expect(bannedTargetRequest.status).toBe(403)
    await app!.pool.query(`INSERT INTO official_rate_limits(key,count,expires_at) VALUES($1,120,now()+interval '60 seconds')
      ON CONFLICT(key) DO UPDATE SET count=120,expires_at=excluded.expires_at`, [digest(`community-write:${rateLimited.id}`)])
    const rateLimitedHeartbeat = await request(rateLimited, '/official/community/heartbeat', {})
    expect(rateLimitedHeartbeat.status).toBe(429)
    expect(rateLimitedHeartbeat.body).toHaveProperty('error')
    const afterUnblockSearch = await request<{ accounts: Array<Record<string, unknown>> }>(
      requester,
      `/official/community/accounts?q=${encodeURIComponent(recipient.name)}`,
    )
    expect(afterUnblockSearch.status).toBe(200)
    expect(afterUnblockSearch.body.accounts.every(account => !Object.hasOwn(account, 'online'))).toBe(true)
    expect(afterUnblockSearch.text).not.toContain('@')
  }, 120_000)

  it('persists pure-text board posts and replies across restart with bounded cursors and author-only deletion', async () => {
    const [author, other] = await seedActors('board', 2)
    const postIds: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const created = await request<{ id: string }>(author, '/official/community/posts', {
        kind: index === 0 ? 'meetup' : 'discussion',
        title: `<b>title-${index}</b>`,
        body: `body-${index}<script>alert(${index})</script>`,
        ...(index === 0 ? { roomCode: 'ABCDEF123456' } : {}),
      })
      expect(created.status).toBe(200)
      expect(created.body.id).toEqual(expect.any(String))
      postIds.push(created.body.id)
    }

    const firstPage = await request<{ announcement: unknown; posts: Array<Record<string, unknown>>; nextCursor?: string }>(
      author,
      '/official/community/board?limit=2',
    )
    expect(firstPage.status).toBe(200)
    expect(firstPage.body.posts.length).toBeLessThanOrEqual(2)
    expect(firstPage.body.posts.every(post => Object.hasOwn(post, 'author'))).toBe(true)
    expect(firstPage.body.posts.every(post => !Object.hasOwn(post, 'email'))).toBe(true)
    expect(firstPage.body.nextCursor).toEqual(expect.any(String))

    const secondPage = await request<{ posts: Array<Record<string, unknown>>; nextCursor?: string }>(
      author,
      `/official/community/board?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor!)}`,
    )
    expect(secondPage.status).toBe(200)
    expect(secondPage.body.posts.length).toBeLessThanOrEqual(2)
    expect(new Set(secondPage.body.posts.map(post => post.id)).size).toBe(secondPage.body.posts.length)
    expect(secondPage.body.posts.map(post => post.id)).not.toEqual(expect.arrayContaining(firstPage.body.posts.map(post => post.id)))

    const postId = postIds[1]
    const deletedPostId = postIds[0]
    const replyIds: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const reply = await request<{ id: string }>(other, `/official/community/posts/${postId}/replies`, {
        body: `reply-${index}<img src=x onerror=alert(1)>`,
      })
      expect(reply.status).toBe(200)
      replyIds.push(reply.body.id)
    }
    const replies = await request<{ replies: Array<Record<string, unknown>>; nextCursor?: string }>(
      author,
      `/official/community/posts/${postId}/replies?limit=2`,
    )
    expect(replies.status).toBe(200)
    expect(replies.body.replies.length).toBeLessThanOrEqual(2)
    expect(replies.body.replies.every(reply => typeof reply.body === 'string')).toBe(true)

    const outsiderPostDelete = await request(other, `/official/community/posts/${postId}/delete`, {})
    expect(outsiderPostDelete.status).toBeGreaterThanOrEqual(400)
    const authorReplyDelete = await request(other, `/official/community/posts/${postId}/replies/${replyIds[0]}/delete`, {})
    expect(authorReplyDelete.status).toBe(200)
    const authorPostDelete = await request(author, `/official/community/posts/${deletedPostId}/delete`, {})
    expect(authorPostDelete.status).toBe(200)
    expect((await request(author, '/official/community/board?limit=20')).body.posts)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: deletedPostId })]))

    expect((await request(author, '/official/community/friends/request', { targetAccountId: other.id })).status).toBe(200)
    expect((await request(other, '/official/community/friends/accept', { targetAccountId: author.id })).status).toBe(200)
    await restartServer()
    const restored = await request<{ posts: Array<Record<string, unknown>> }>(author, '/official/community/board?limit=20')
    expect(restored.status).toBe(200)
    expect(restored.body.posts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: postIds[1], title: '<b>title-1</b>', body: expect.stringContaining('<script>') }),
    ]))
    expect(restored.body.posts).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: deletedPostId })]))
    const restoredFriends = await request<CommunityFriends>(author, '/official/community/friends')
    expect(restoredFriends.body.friends).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: other.id, online: false }),
    ]))
    const restoredReplies = await request<{ replies: Array<Record<string, unknown>> }>(
      author,
      `/official/community/posts/${postId}/replies?limit=20`,
    )
    expect(restoredReplies.status).toBe(200)
    expect(restoredReplies.body.replies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: replyIds[1], body: expect.stringContaining('<img') }),
      expect.objectContaining({ id: replyIds[2], body: expect.stringContaining('<img') }),
    ]))
  }, 180_000)

  it('allows only loopback admin moderation and records hidden-content audit evidence', async () => {
    const [author, outsider] = await seedActors('moderation', 2)
    const created = await request<{ id: string }>(author, '/official/community/posts', {
      kind: 'discussion',
      title: 'moderation target',
      body: 'moderation body',
    })
    expect(created.status).toBe(200)
    const postId = created.body.id

    const unauthenticatedAdmin = await fetch(origin + '/official/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid' },
      body: JSON.stringify({ action: 'community-hide-post', value: postId, reason: 'integration test' }),
    })
    expect(unauthenticatedAdmin.status).toBe(403)

    const hidden = await fetch(origin + '/official/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` },
      body: JSON.stringify({ action: 'community-hide-post', value: postId, reason: 'integration test' }),
    })
    expect(hidden.status).toBe(200)
    expect((await request(outsider, '/official/community/board?limit=20')).body.posts)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: postId })]))

    const hiddenSearch = await app!.community.moderation(0, { q: 'moderation target', status: 'hidden', kind: 'posts' })
    expect(hiddenSearch.posts).toEqual(expect.arrayContaining([expect.objectContaining({ id: postId, hidden: true, deleted: false })]))
    expect(hiddenSearch.replies).toHaveLength(0)
    const visiblePosts = await app!.community.moderation(0, { status: 'visible', kind: 'posts' })
    expect(visiblePosts.posts).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: postId })]))

    const panel = await startControlPanel({
      ranked: app!.ranked,
      community: app!.community,
      mail: {
        status: () => ({ host: 'smtp.example.test', port: 465, sent: 0, failed: 0, checkedAt: null, connected: null, lastSentAt: null, lastFailedAt: null }),
        verify: async () => true,
      },
      assetsRoot: path.resolve('lib/server/official/panel'),
      pagesRoot: path.resolve('data/pages'),
      playerPort: port,
      shutdown: async () => {},
    })
    try {
      const panelUrl = new URL(panel.url)
      const panelHeaders = { Authorization: `Bearer ${panelUrl.hash.slice(1)}` }
      const unauthorizedPanel = await fetch(panelUrl.origin + '/api/community', {
        headers: { Authorization: 'Bearer invalid' },
      })
      expect(unauthorizedPanel.status).toBe(403)
      const panelCommunity = await fetch(panelUrl.origin + '/api/community', { headers: panelHeaders })
      expect(panelCommunity.status).toBe(200)
      const panelBody = await panelCommunity.json() as { posts: Array<{ id: string; hidden: boolean }> }
      expect(panelBody.posts).toEqual(expect.arrayContaining([expect.objectContaining({ id: postId, hidden: true })]))
    } finally {
      await panel.close()
    }

    const unauthorizedRestore = await fetch(origin + '/official/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({ action: 'community-restore-post', value: postId, reason: 'restore attempt' }),
    })
    expect(unauthorizedRestore.status).toBe(403)
    const restored = await fetch(origin + '/official/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` },
      body: JSON.stringify({ action: 'community-restore-post', value: postId, reason: 'restore for review' }),
    })
    expect(restored.status).toBe(200)
    expect((await request(outsider, '/official/community/board?limit=20')).body.posts)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: postId })]))
    const reply = await request<{ id: string }>(outsider, `/official/community/posts/${postId}/replies`, { body: 'reply moderation target' })
    expect(reply.status).toBe(200)
    const hiddenReply = await fetch(origin + '/official/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` },
      body: JSON.stringify({ action: 'community-hide-reply', value: reply.body.id, reason: 'reply moderation' }),
    })
    expect(hiddenReply.status).toBe(200)
    expect((await app!.community.moderation(0, { q: 'reply moderation target', status: 'hidden', kind: 'replies' })).replies)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: reply.body.id, hidden: true })]))
    const restoredReply = await fetch(origin + '/official/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` },
      body: JSON.stringify({ action: 'community-restore-reply', value: reply.body.id, reason: 'reply restore' }),
    })
    expect(restoredReply.status).toBe(200)
    expect((await request(outsider, `/official/community/posts/${postId}/replies?limit=20`)).body.replies)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: reply.body.id })]))

    const deletedPost = await request<{ id: string }>(author, '/official/community/posts', {
      kind: 'discussion', title: 'deleted moderation target', body: 'author deleted',
    })
    expect(deletedPost.status).toBe(200)
    expect((await request(author, `/official/community/posts/${deletedPost.body.id}/delete`, {})).status).toBe(200)
    const restoreDeleted = await fetch(origin + '/official/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` },
      body: JSON.stringify({ action: 'community-restore-post', value: deletedPost.body.id, reason: 'cannot restore author deletion' }),
    })
    expect(restoreDeleted.status).toBe(409)
    expect((await app!.community.moderation(0, { status: 'deleted', kind: 'posts' })).posts)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: deletedPost.body.id, deleted: true })]))

    const audit = await app!.pool.query<{ action: string; detail: { value?: string; reason?: string } }>(
      'SELECT action, detail FROM official_audit ORDER BY id DESC LIMIT 20',
    )
    const moderationAudit = audit.rows.find(row => row.action === 'community-hide-post' && row.detail.value === postId)
    expect(moderationAudit).toMatchObject({ action: expect.stringMatching(/community|moder/i) })
    expect(moderationAudit!.detail.reason).toBe('integration test')
    expect(audit.rows.some(row => row.action === 'community-restore-post' && row.detail.value === postId)).toBe(true)
  }, 120_000)

  it('keeps older posts and replies reachable through bounded moderation pages', async () => {
    const [author] = await seedActors('history', 1)
    const prefix = randomUUID()
    await app!.pool.query(`INSERT INTO official_community_posts(id,author_id,kind,title,body,created_at)
      SELECT $1 || '-' || n,$2,'discussion','history','body',now()+n*interval '1 second'
      FROM generate_series(1,105) n`, [prefix, author.id])
    await app!.pool.query(`INSERT INTO official_community_replies(id,post_id,author_id,body,created_at)
      SELECT $1 || '-reply-' || n,$1 || '-1',$2,'reply',now()+n*interval '1 second'
      FROM generate_series(1,105) n`, [prefix, author.id])
    const first = await app!.community.moderation()
    expect(first.more).toBe(true)
    expect(first.posts).toHaveLength(100)
    expect(first.replies).toHaveLength(100)
    const second = await app!.community.moderation(100)
    expect(second.posts.some(row => row.id === prefix + '-1')).toBe(true)
    expect(second.replies.some(row => row.id === prefix + '-reply-1')).toBe(true)
    await app!.community.administer('community-hide-post', prefix + '-1', 'history moderation')
    expect((await app!.community.moderation(100)).posts.find(row => row.id === prefix + '-1')?.hidden).toBe(true)
    await app!.community.administer('community-restore-post', prefix + '-1', 'history restore')
    expect((await app!.community.moderation(100, { status: 'visible', kind: 'posts' })).posts.find(row => row.id === prefix + '-1')?.hidden).toBe(false)
    await expect(app!.community.moderation(0, { status: 'unknown' })).rejects.toThrow('审核状态无效')
    await expect(app!.community.moderation(0, { q: 'x'.repeat(201) })).rejects.toThrow('审核搜索内容长度无效')
    await expect(app!.community.moderation(-1)).rejects.toThrow('审核页码无效')
    await expect(app!.community.moderation(1.5)).rejects.toThrow('审核页码无效')
    await expect(app!.community.moderation(1000001)).rejects.toThrow('审核页码无效')
  }, 120_000)

  async function seedActors(prefix: string, count: number): Promise<Actor[]> {
    const suffix = randomUUID().slice(0, 8)
    const actors: Actor[] = []
    for (let index = 0; index < count; index += 1) {
      const id = `red242-${prefix}-${suffix}-${index}`
      const token = `red242-token-${prefix}-${suffix}-${index}-${randomUUID()}`
      const actor = { id, email: `${id}@example.test`, name: `${prefix}-${suffix}-${index}`, token }
      await app!.pool.query(
        'INSERT INTO official_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
        [actor.id, actor.email, actor.name, 'fixture-password-hash'],
      )
      await app!.pool.query(
        'INSERT INTO official_sessions(token_hash,account_id) VALUES($1,$2)',
        [digest(actor.token), actor.id],
      )
      actors.push(actor)
    }
    return actors
  }

  async function request<T = Record<string, unknown>>(
    actor: Actor | undefined,
    route: string,
    body?: unknown,
  ): Promise<HttpResult<T>> {
    const response = await fetch(origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed: unknown = {}
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = {} }
    return { status: response.status, body: parsed as T, text }
  }

  async function restartServer() {
    await app!.close()
    app = await createOfficialServer({
      databaseUrl: scopedDatabaseUrl,
      mail: async () => {},
      adminToken: adminSecret,
    })
    port = await findFreePort(39042)
    await app.start(port)
    origin = `http://127.0.0.1:${port}`
  }

  async function expirePresence(accountId: string) {
    const presence = await app!.pool.query<{ table_name: string; account_column: string; expiry_column: string }>(`
      SELECT account_column.column_name AS account_column, expiry_column.table_name, expiry_column.column_name AS expiry_column
      FROM information_schema.columns account_column
      JOIN information_schema.columns expiry_column
        ON expiry_column.table_schema = account_column.table_schema
       AND expiry_column.table_name = account_column.table_name
      WHERE account_column.table_schema = current_schema()
        AND account_column.column_name IN ('account_id', 'user_id')
        AND expiry_column.column_name IN ('expires_at', 'last_seen_at', 'heartbeat_at', 'updated_at')
        AND (account_column.table_name ILIKE '%presence%' OR account_column.table_name ILIKE '%heartbeat%')
      LIMIT 1
    `)
    expect(presence.rows).toHaveLength(1)
    const row = presence.rows[0]
    await app!.pool.query(
      `UPDATE ${quoteIdentifier(row.table_name)} SET ${quoteIdentifier(row.expiry_column)}=now()-interval '91 seconds' WHERE ${quoteIdentifier(row.account_column)}=$1`,
      [accountId],
    )
  }
})

function pendingRepresentationCount(friends: CommunityFriends, targetId: string): number {
  return friends.incoming.filter(friend => friend.id === targetId).length
    + friends.outgoing.filter(friend => friend.id === targetId).length
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString)
  url.searchParams.set('options', `-c search_path=${schema},public`)
  return url.toString()
}
