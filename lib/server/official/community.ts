import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

import { OfficialError, transaction } from './accounts'

const MAX_ACCOUNT_QUERY = 100
const MAX_FRIEND_LIST = 200
const MAX_PAGE = 20
const PRESENCE_TTL_SECONDS = 90

/**
 * Social data is deliberately kept outside the ranked and battle tables.  The
 * account pair is stored in lexical order so every relationship mutation can
 * acquire the same two row locks, regardless of which account initiated it.
 */
export const COMMUNITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS official_community_friendships (
  account_low TEXT NOT NULL REFERENCES official_accounts(id) ON DELETE CASCADE,
  account_high TEXT NOT NULL REFERENCES official_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  requester_id TEXT NOT NULL REFERENCES official_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(account_low, account_high),
  CHECK (account_low < account_high),
  CHECK (requester_id = account_low OR requester_id = account_high)
);
CREATE INDEX IF NOT EXISTS official_community_friendships_requester
  ON official_community_friendships(requester_id, status, created_at);

CREATE TABLE IF NOT EXISTS official_community_blocks (
  blocker_id TEXT NOT NULL REFERENCES official_accounts(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES official_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS official_community_blocks_blocked
  ON official_community_blocks(blocked_id, blocker_id);

CREATE TABLE IF NOT EXISTS official_community_presence (
  account_id TEXT PRIMARY KEY REFERENCES official_accounts(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS official_community_posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES official_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('meetup','discussion')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  room_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hidden_at TIMESTAMPTZ,
  hidden_by TEXT,
  hidden_reason TEXT
);
CREATE INDEX IF NOT EXISTS official_community_posts_feed
  ON official_community_posts(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS official_community_posts_author
  ON official_community_posts(author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS official_community_replies (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES official_community_posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES official_accounts(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hidden_at TIMESTAMPTZ,
  hidden_by TEXT,
  hidden_reason TEXT
);
CREATE INDEX IF NOT EXISTS official_community_replies_feed
  ON official_community_replies(post_id, created_at DESC, id DESC);

-- official_audit is normally created by Ranked.  Keeping this compatible
-- create here also lets the community service be initialized in isolation.
CREATE TABLE IF NOT EXISTS official_audit (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  detail JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`

type FriendshipRow = {
  account_low: string
  account_high: string
  status: 'pending' | 'accepted'
  requester_id: string
}

type CursorValue = { createdAt: string; id: string }

type TextOptions = {
  field: string
  max: number
  required?: boolean
  printable?: boolean
}

export type CommunityPostInput = {
  kind: unknown
  title: unknown
  body: unknown
  roomCode?: unknown
}

export type CommunityModerationFilters = {
  q?: unknown
  status?: unknown
  kind?: unknown
}

export type Community = {
  initialize(): Promise<void>
  search(accountId: string, query: unknown): Promise<Array<{ id: string; name: string }>>
  friends(accountId: string): Promise<{
    friends: Array<{ id: string; name: string; online: boolean }>
    incoming: Array<{ id: string; name: string; createdAt: Date }>
    outgoing: Array<{ id: string; name: string; createdAt: Date }>
    blocked: Array<{ id: string; name: string }>
  }>
  heartbeat(accountId: string): Promise<void>
  request(accountId: string, targetAccountId: unknown): Promise<void>
  accept(accountId: string, targetAccountId: unknown): Promise<void>
  reject(accountId: string, targetAccountId: unknown): Promise<void>
  withdraw(accountId: string, targetAccountId: unknown): Promise<void>
  remove(accountId: string, targetAccountId: unknown): Promise<void>
  block(accountId: string, targetAccountId: unknown): Promise<void>
  unblock(accountId: string, targetAccountId: unknown): Promise<void>
  board(accountId: string, cursor?: unknown, limit?: unknown): Promise<{
    announcement: string
    posts: Array<Record<string, unknown>>
    nextCursor?: string
  }>
  createPost(accountId: string, input: CommunityPostInput): Promise<string>
  replies(accountId: string, postId: unknown, cursor?: unknown, limit?: unknown): Promise<{
    replies: Array<Record<string, unknown>>
    nextCursor?: string
  }>
  createReply(accountId: string, postId: unknown, body: unknown): Promise<string>
  deletePost(accountId: string, postId: unknown): Promise<void>
  deleteReply(accountId: string, postIdOrReplyId: unknown, replyId?: unknown): Promise<void>
  moderation(offset?: number, filters?: CommunityModerationFilters): Promise<{ posts: Array<Record<string, unknown>>; replies: Array<Record<string, unknown>>; more: boolean }>
  administer(action: string, value: unknown, reason?: unknown): Promise<void>
}

type AccountRow = { id: string; name: string }

function pair(accountId: string, targetAccountId: string): [string, string] {
  return accountId < targetAccountId ? [accountId, targetAccountId] : [targetAccountId, accountId]
}

function accountId(value: unknown): string {
  if (typeof value !== 'string') throw new OfficialError('账号标识无效')
  const result = value.trim()
  if (!result || result.length > 128 || /[\u0000-\u001f\u007f]/.test(result)) throw new OfficialError('账号标识无效')
  return result
}

function plainText(value: unknown, options: TextOptions): string {
  if (typeof value !== 'string') throw new OfficialError(`${options.field}格式无效`)
  const result = value.trim()
  if ((!result && options.required !== false) || result.length > options.max) throw new OfficialError(`${options.field}长度无效`)
  // Keep line breaks and tabs useful in post bodies, while rejecting control
  // characters which can become ambiguous in logs, headers, or panel output.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/.test(result)) throw new OfficialError(`${options.field}包含不可用字符`)
  if (options.printable && !/^[\x20-\x7e]*$/.test(result)) throw new OfficialError(`${options.field}包含不可用字符`)
  return result
}

type ModerationStatus = 'all' | 'visible' | 'hidden' | 'deleted'
type ModerationKind = 'all' | 'posts' | 'replies'

function moderationQuery(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  return plainText(value, { field: '审核搜索内容', max: 200, required: false })
}

function moderationStatus(value: unknown): ModerationStatus {
  if (value === undefined || value === null || value === '') return 'all'
  if (value === 'all' || value === 'visible' || value === 'hidden' || value === 'deleted') return value
  throw new OfficialError('审核状态无效')
}

function moderationKind(value: unknown): ModerationKind {
  if (value === undefined || value === null || value === '') return 'all'
  if (value === 'all' || value === 'posts' || value === 'replies') return value
  throw new OfficialError('审核内容类型无效')
}

function optionalRoomCode(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  return plainText(value, { field: '房间码', max: 80, printable: true })
}

function pageLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return MAX_PAGE
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new OfficialError('分页数量无效')
  return Math.min(MAX_PAGE, number)
}

function decodeCursor(value: unknown): CursorValue | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new OfficialError('分页游标无效')
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!decoded || typeof decoded !== 'object' || typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string') throw new Error()
    if (decoded.id.length < 1 || decoded.id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(decoded.id)) throw new Error()
    if (!/^\d{1,16}$/.test(decoded.createdAt)) throw new Error()
    const micros = Number(decoded.createdAt)
    if (!Number.isSafeInteger(micros) || micros < 0) throw new Error()
    return { createdAt: decoded.createdAt, id: decoded.id }
  } catch {
    throw new OfficialError('分页游标无效')
  }
}

function encodeCursor(createdAt: unknown, id: string): string {
  if (typeof createdAt === 'string' && /^\d{1,16}$/.test(createdAt)) return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url')
  const date = createdAt instanceof Date ? createdAt : new Date(String(createdAt))
  return Buffer.from(JSON.stringify({ createdAt: String(date.getTime() * 1000), id })).toString('base64url')
}

function iso(value: unknown): string {
  return new Date(value instanceof Date ? value : String(value)).toISOString()
}

async function lockAccounts(client: PoolClient, accountIdValue: string, targetId: string) {
  const ids = pair(accountIdValue, targetId)
  const rows = await client.query<{ id: string; banned: boolean }>('SELECT id,banned FROM official_accounts WHERE id=ANY($1) ORDER BY id FOR UPDATE', [ids])
  if (rows.rowCount !== 2) throw new OfficialError('账号不存在', 404)
  if (rows.rows.some(row => row.banned)) throw new OfficialError('该账号暂时无法操作', 403)
  return ids
}

async function relationshipCount(client: PoolClient, accountIdValue: string): Promise<number> {
  return Number((await client.query<{ count: string }>(`SELECT count(*)::int AS count
    FROM official_community_friendships WHERE account_low=$1 OR account_high=$1`, [accountIdValue])).rows[0].count)
}

async function ensureRelationshipCapacity(client: PoolClient, first: string, second: string, additional = 1) {
  const [firstCount, secondCount] = await Promise.all([relationshipCount(client, first), relationshipCount(client, second)])
  if (firstCount + additional > MAX_FRIEND_LIST || secondCount + additional > MAX_FRIEND_LIST) throw new OfficialError('好友或申请列表已满', 409)
}

async function blockedPair(client: PoolClient, first: string, second: string): Promise<boolean> {
  return !!(await client.query(
    'SELECT 1 FROM official_community_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1',
    [first, second],
  )).rowCount
}

function requireDifferent(accountIdValue: string, targetValue: unknown): string {
  const target = accountId(targetValue)
  if (target === accountIdValue) throw new OfficialError('不能对自己执行好友操作')
  return target
}

export class CommunityService implements Community {
  constructor(readonly pool: Pool) {}

  async initialize() {
    await this.pool.query(COMMUNITY_SCHEMA)
  }

  async search(accountIdValue: string, query: unknown) {
    const value = plainText(query, { field: '搜索内容', max: 80 })
    if (value.length < 2) {
      const exact = /^[A-Za-z0-9_-]{1,128}$/.test(value)
        ? await this.pool.query<AccountRow>('SELECT id,name FROM official_accounts WHERE id=$1 AND NOT banned', [value])
        : { rowCount: 0, rows: [] as AccountRow[] }
      if (!exact.rowCount) throw new OfficialError('搜索至少需要2个字符')
      return exact.rows
    }
    // accountIdValue is intentionally accepted by the service boundary so a
    // caller can later exclude itself without trusting a client supplied ID.
    void accountIdValue
    const result = await this.pool.query<AccountRow>(`SELECT id,name FROM official_accounts
      WHERE NOT banned AND (strpos(lower(name),lower($1))>0 OR id=$1)
      ORDER BY name,id LIMIT $2`, [value, MAX_ACCOUNT_QUERY])
    return result.rows
  }

  async friends(accountIdValue: string) {
    const friends = await this.pool.query<{ id: string; name: string; online: boolean }>(`SELECT a.id,a.name,
      coalesce(p.last_seen_at > now()-interval '${PRESENCE_TTL_SECONDS} seconds',false) AS online
      FROM official_community_friendships f
      JOIN official_accounts a ON a.id=CASE WHEN f.account_low=$1 THEN f.account_high ELSE f.account_low END
      LEFT JOIN official_community_presence p ON p.account_id=a.id
      WHERE f.status='accepted' AND (f.account_low=$1 OR f.account_high=$1) AND NOT a.banned
      ORDER BY a.name,a.id LIMIT $2`, [accountIdValue, MAX_FRIEND_LIST])
    const incoming = await this.pool.query<{ id: string; name: string; created_at: Date }>(`SELECT a.id,a.name,f.created_at
      FROM official_community_friendships f JOIN official_accounts a ON a.id= f.requester_id
      WHERE f.status='pending' AND f.requester_id<>$1
        AND (f.account_low=$1 OR f.account_high=$1) AND NOT a.banned
      ORDER BY f.created_at,f.account_low,f.account_high LIMIT $2`, [accountIdValue, MAX_FRIEND_LIST])
    const outgoing = await this.pool.query<{ id: string; name: string; created_at: Date }>(`SELECT a.id,a.name,f.created_at
      FROM official_community_friendships f
      JOIN official_accounts a ON a.id=CASE WHEN f.account_low=$1 THEN f.account_high ELSE f.account_low END
      WHERE f.status='pending' AND f.requester_id=$1 AND NOT a.banned
      ORDER BY f.created_at,f.account_low,f.account_high LIMIT $2`, [accountIdValue, MAX_FRIEND_LIST])
    const blocked = await this.pool.query<{ id: string; name: string }>(`SELECT a.id,a.name
      FROM official_community_blocks b JOIN official_accounts a ON a.id=b.blocked_id
      WHERE b.blocker_id=$1 AND NOT a.banned ORDER BY a.name,a.id LIMIT $2`, [accountIdValue, MAX_FRIEND_LIST])
    return {
      friends: friends.rows,
      incoming: incoming.rows.map(row => ({ id: row.id, name: row.name, createdAt: row.created_at })),
      outgoing: outgoing.rows.map(row => ({ id: row.id, name: row.name, createdAt: row.created_at })),
      blocked: blocked.rows,
    }
  }

  async heartbeat(accountIdValue: string) {
    await this.pool.query(`INSERT INTO official_community_presence(account_id,last_seen_at) VALUES($1,now())
      ON CONFLICT(account_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`, [accountIdValue])
  }

  async request(accountIdValue: string, targetAccountId: unknown) {
    const target = requireDifferent(accountIdValue, targetAccountId)
    await transaction(this.pool, async client => {
      const [low, high] = await lockAccounts(client, accountIdValue, target)
      if (await blockedPair(client, accountIdValue, target)) throw new OfficialError('该账号暂时无法添加好友', 403)
      const existing = (await client.query<FriendshipRow>(`SELECT account_low,account_high,status,requester_id
        FROM official_community_friendships WHERE account_low=$1 AND account_high=$2 FOR UPDATE`, [low, high])).rows[0]
      if (!existing) {
        await ensureRelationshipCapacity(client, accountIdValue, target)
        await client.query(`INSERT INTO official_community_friendships(account_low,account_high,status,requester_id)
          VALUES($1,$2,'pending',$3)`, [low, high, accountIdValue])
      }
      // A second request in the opposite direction leaves the one canonical
      // pending row alone.  The actual recipient must explicitly accept it.
    })
  }

  async accept(accountIdValue: string, targetAccountId: unknown) {
    const target = requireDifferent(accountIdValue, targetAccountId)
    await transaction(this.pool, async client => {
      const [low, high] = await lockAccounts(client, accountIdValue, target)
      const existing = (await client.query<FriendshipRow>(`SELECT account_low,account_high,status,requester_id
        FROM official_community_friendships WHERE account_low=$1 AND account_high=$2 FOR UPDATE`, [low, high])).rows[0]
      if (!existing) throw new OfficialError('好友申请不存在', 404)
      if (existing.status === 'accepted') return
      if (existing.requester_id === accountIdValue) throw new OfficialError('不能接受自己发出的申请')
      // Pending relationships already consume one of the bounded slots.  The
      // zero-additional check still protects against legacy data that exceeds
      // the cap before converting it to an accepted relationship.
      await ensureRelationshipCapacity(client, accountIdValue, target, 0)
      await client.query(`UPDATE official_community_friendships SET status='accepted',updated_at=now()
        WHERE account_low=$1 AND account_high=$2`, [low, high])
    })
  }

  async reject(accountIdValue: string, targetAccountId: unknown) {
    const target = requireDifferent(accountIdValue, targetAccountId)
    await transaction(this.pool, async client => {
      const [low, high] = await lockAccounts(client, accountIdValue, target)
      const existing = (await client.query<FriendshipRow>(`SELECT status,requester_id,account_low,account_high
        FROM official_community_friendships WHERE account_low=$1 AND account_high=$2 FOR UPDATE`, [low, high])).rows[0]
      if (!existing) return
      if (existing.status === 'accepted') throw new OfficialError('好友关系请使用删除操作')
      if (existing.requester_id === accountIdValue) throw new OfficialError('不能拒绝自己发出的申请')
      await client.query('DELETE FROM official_community_friendships WHERE account_low=$1 AND account_high=$2', [low, high])
    })
  }

  async withdraw(accountIdValue: string, targetAccountId: unknown) {
    const target = requireDifferent(accountIdValue, targetAccountId)
    await transaction(this.pool, async client => {
      const [low, high] = await lockAccounts(client, accountIdValue, target)
      const existing = (await client.query<FriendshipRow>(`SELECT status,requester_id,account_low,account_high
        FROM official_community_friendships WHERE account_low=$1 AND account_high=$2 FOR UPDATE`, [low, high])).rows[0]
      if (!existing) return
      if (existing.status === 'accepted') throw new OfficialError('好友关系不能撤回，请使用删除操作')
      if (existing.requester_id !== accountIdValue) throw new OfficialError('只能撤回自己发出的申请')
      await client.query('DELETE FROM official_community_friendships WHERE account_low=$1 AND account_high=$2', [low, high])
    })
  }

  async remove(accountIdValue: string, targetAccountId: unknown) {
    const target = requireDifferent(accountIdValue, targetAccountId)
    await transaction(this.pool, async client => {
      const [low, high] = await lockAccounts(client, accountIdValue, target)
      const existing = (await client.query<FriendshipRow>(`SELECT status,requester_id,account_low,account_high
        FROM official_community_friendships WHERE account_low=$1 AND account_high=$2 FOR UPDATE`, [low, high])).rows[0]
      if (!existing) return
      if (existing.status !== 'accepted') throw new OfficialError('待处理申请请使用拒绝或撤回操作')
      await client.query('DELETE FROM official_community_friendships WHERE account_low=$1 AND account_high=$2', [low, high])
    })
  }

  async block(accountIdValue: string, targetAccountId: unknown) {
    const target = requireDifferent(accountIdValue, targetAccountId)
    await transaction(this.pool, async client => {
      await lockAccounts(client, accountIdValue, target)
      const alreadyBlocked = !!(await client.query('SELECT 1 FROM official_community_blocks WHERE blocker_id=$1 AND blocked_id=$2', [accountIdValue, target])).rowCount
      if (!alreadyBlocked) {
        const blockCount = Number((await client.query<{ count: string }>('SELECT count(*)::int AS count FROM official_community_blocks WHERE blocker_id=$1', [accountIdValue])).rows[0].count)
        if (blockCount >= MAX_FRIEND_LIST) throw new OfficialError('屏蔽列表已满', 409)
      }
      await client.query(`INSERT INTO official_community_blocks(blocker_id,blocked_id) VALUES($1,$2)
        ON CONFLICT(blocker_id,blocked_id) DO NOTHING`, [accountIdValue, target])
      const [low, high] = pair(accountIdValue, target)
      await client.query('DELETE FROM official_community_friendships WHERE account_low=$1 AND account_high=$2', [low, high])
    })
  }

  async unblock(accountIdValue: string, targetAccountId: unknown) {
    const target = requireDifferent(accountIdValue, targetAccountId)
    await transaction(this.pool, async client => {
      await lockAccounts(client, accountIdValue, target)
      await client.query('DELETE FROM official_community_blocks WHERE blocker_id=$1 AND blocked_id=$2', [accountIdValue, target])
    })
  }

  async board(accountIdValue: string, cursorValue?: unknown, limitValue?: unknown) {
    void accountIdValue
    const limit = pageLimit(limitValue), cursor = decodeCursor(cursorValue)
    const feed = await this.pool.query<{
      id: string
      author_id: string
      author_name: string
      kind: 'meetup' | 'discussion'
      title: string
      body: string
      room_code: string | null
      created_at: Date
      created_at_cursor: string
      reply_count: number
    }>(`SELECT p.id,p.author_id,a.name AS author_name,p.kind,p.title,p.body,p.room_code,p.created_at,
      floor(extract(epoch from p.created_at)*1000000)::text AS created_at_cursor,
      (SELECT count(*)::int FROM official_community_replies r
        JOIN official_accounts ra ON ra.id=r.author_id AND NOT ra.banned
        WHERE r.post_id=p.id AND r.deleted_at IS NULL AND r.hidden_at IS NULL) AS reply_count
      FROM official_community_posts p JOIN official_accounts a ON a.id=p.author_id AND NOT a.banned
      WHERE p.deleted_at IS NULL AND p.hidden_at IS NULL
        ${cursor ? 'AND (floor(extract(epoch from p.created_at)*1000000),p.id)<($1::numeric,$2)' : ''}
      ORDER BY p.created_at DESC,p.id DESC LIMIT $${cursor ? 3 : 1}`, cursor ? [cursor.createdAt, cursor.id, limit + 1] : [limit + 1])
    const rows = feed.rows.slice(0, limit)
    const posts = rows.map(row => {
      const result: Record<string, unknown> = {
        id: row.id,
        author: { id: row.author_id, name: row.author_name },
        kind: row.kind,
        title: row.title,
        body: row.body,
        createdAt: iso(row.created_at),
        replyCount: Number(row.reply_count),
      }
      if (row.room_code !== null) result.roomCode = row.room_code
      return result
    })
    return {
      announcement: String((await this.pool.query<{ announcement: string }>('SELECT announcement FROM official_settings LIMIT 1')).rows[0]?.announcement ?? ''),
      posts,
      ...(feed.rows.length > limit && rows.length ? { nextCursor: encodeCursor(rows[rows.length - 1].created_at_cursor, rows[rows.length - 1].id) } : {}),
    }
  }

  async createPost(accountIdValue: string, input: CommunityPostInput) {
    if (!input || typeof input !== 'object') throw new OfficialError('帖子格式无效')
    const kind = input.kind === 'meetup' || input.kind === 'discussion' ? input.kind : (() => { throw new OfficialError('帖子类型无效') })()
    const title = plainText(input.title, { field: '标题', max: 80 })
    const body = plainText(input.body, { field: '正文', max: 2000 })
    const roomCode = optionalRoomCode(input.roomCode)
    const id = randomUUID()
    await this.pool.query(`INSERT INTO official_community_posts(id,author_id,kind,title,body,room_code)
      VALUES($1,$2,$3,$4,$5,$6)`, [id, accountIdValue, kind, title, body, roomCode])
    return id
  }

  async replies(accountIdValue: string, postIdValue: unknown, cursorValue?: unknown, limitValue?: unknown) {
    void accountIdValue
    const postId = accountId(postIdValue), limit = pageLimit(limitValue), cursor = decodeCursor(cursorValue)
    const post = await this.pool.query<{ deleted_at: Date | null; hidden_at: Date | null }>(`SELECT p.deleted_at,p.hidden_at
      FROM official_community_posts p JOIN official_accounts a ON a.id=p.author_id AND NOT a.banned WHERE p.id=$1`, [postId])
    if (!post.rowCount) throw new OfficialError('帖子不存在', 404)
    // A removed or moderated post remains addressable as an empty thread.  It
    // avoids leaking whether a hidden post had replies while keeping deletion
    // idempotent for clients that refresh an older detail view.
    if (post.rows[0].deleted_at || post.rows[0].hidden_at) return { replies: [] }
    const result = await this.pool.query<{
      id: string
      author_id: string
      author_name: string
      body: string
      created_at: Date
      created_at_cursor: string
    }>(`SELECT r.id,r.author_id,a.name AS author_name,r.body,r.created_at,
        floor(extract(epoch from r.created_at)*1000000)::text AS created_at_cursor
      FROM official_community_replies r JOIN official_accounts a ON a.id=r.author_id AND NOT a.banned
      WHERE r.post_id=$${cursor ? 3 : 1} AND r.deleted_at IS NULL AND r.hidden_at IS NULL
        ${cursor ? 'AND (floor(extract(epoch from r.created_at)*1000000),r.id)<($1::numeric,$2)' : ''}
      ORDER BY r.created_at DESC,r.id DESC LIMIT $${cursor ? 4 : 2}`, cursor ? [cursor.createdAt, cursor.id, postId, limit + 1] : [postId, limit + 1])
    const rows = result.rows.slice(0, limit)
    return {
      replies: rows.map(row => ({ id: row.id, author: { id: row.author_id, name: row.author_name }, body: row.body, createdAt: iso(row.created_at) })),
      ...(result.rows.length > limit && rows.length ? { nextCursor: encodeCursor(rows[rows.length - 1].created_at_cursor, rows[rows.length - 1].id) } : {}),
    }
  }

  async createReply(accountIdValue: string, postIdValue: unknown, bodyValue: unknown) {
    const postId = accountId(postIdValue), body = plainText(bodyValue, { field: '回复', max: 500 })
    const post = await this.pool.query(`SELECT 1 FROM official_community_posts p
      JOIN official_accounts a ON a.id=p.author_id AND NOT a.banned
      WHERE p.id=$1 AND p.deleted_at IS NULL AND p.hidden_at IS NULL`, [postId])
    if (!post.rowCount) throw new OfficialError('帖子不存在', 404)
    const id = randomUUID()
    await this.pool.query(`INSERT INTO official_community_replies(id,post_id,author_id,body) VALUES($1,$2,$3,$4)`, [id, postId, accountIdValue, body])
    return id
  }

  async deletePost(accountIdValue: string, postIdValue: unknown) {
    const postId = accountId(postIdValue)
    await transaction(this.pool, async client => {
      const row = (await client.query<{ author_id: string; deleted_at: Date | null }>('SELECT author_id,deleted_at FROM official_community_posts WHERE id=$1 FOR UPDATE', [postId])).rows[0]
      if (!row) throw new OfficialError('帖子不存在', 404)
      if (row.author_id !== accountIdValue) throw new OfficialError('只能删除自己的帖子', 403)
      if (!row.deleted_at) await client.query('UPDATE official_community_posts SET deleted_at=now() WHERE id=$1', [postId])
    })
  }

  async deleteReply(accountIdValue: string, postIdValue: unknown, replyIdValue?: unknown) {
    const nested = replyIdValue !== undefined
    const requestedPostId = nested ? accountId(postIdValue) : undefined
    const replyId = accountId(nested ? replyIdValue : postIdValue)
    await transaction(this.pool, async client => {
      const row = (await client.query<{ author_id: string; deleted_at: Date | null }>(
        nested
          ? 'SELECT author_id,deleted_at FROM official_community_replies WHERE id=$1 AND post_id=$2 FOR UPDATE'
          : 'SELECT author_id,deleted_at FROM official_community_replies WHERE id=$1 FOR UPDATE',
        nested ? [replyId, requestedPostId] : [replyId],
      )).rows[0]
      if (!row) throw new OfficialError('回复不存在', 404)
      if (row.author_id !== accountIdValue) throw new OfficialError('只能删除自己的回复', 403)
      if (!row.deleted_at) await client.query('UPDATE official_community_replies SET deleted_at=now() WHERE id=$1', [replyId])
    })
  }

  async moderation(offset = 0, filters: CommunityModerationFilters = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new OfficialError('审核页码无效')
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new OfficialError('审核筛选无效')
    const query = moderationQuery(filters.q)
    const status = moderationStatus(filters.status)
    const kind = moderationKind(filters.kind)

    const queryRows = async (contentKind: 'post' | 'reply') => {
      const alias = contentKind === 'post' ? 'p' : 'r'
      const clauses: string[] = []
      const params: unknown[] = []
      const parameter = (value: unknown) => {
        params.push(value)
        return `$${params.length}`
      }
      if (status === 'visible') clauses.push(`${alias}.deleted_at IS NULL AND ${alias}.hidden_at IS NULL`)
      else if (status === 'hidden') clauses.push(`${alias}.deleted_at IS NULL AND ${alias}.hidden_at IS NOT NULL`)
      else if (status === 'deleted') clauses.push(`${alias}.deleted_at IS NOT NULL`)
      if (query) {
        const value = parameter(query)
        const fields = contentKind === 'post'
          ? [`${alias}.id`, `${alias}.title`, `${alias}.body`, 'a.id', 'a.name']
          : [`${alias}.id`, `${alias}.post_id`, `${alias}.body`, 'a.id', 'a.name', 'parent.title']
        clauses.push(`(${fields.map(field => `strpos(lower(${field}),lower(${value}))>0`).join(' OR ')})`)
      }
      const offsetParameter = parameter(offset)
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      params.push(101)
      const limitParameter = `$${params.length}`
      const result = contentKind === 'post'
        ? await this.pool.query(`SELECT p.id,p.author_id,a.name AS author_name,p.kind,p.title,p.body,p.room_code,
            p.created_at,p.deleted_at,p.hidden_at,p.hidden_reason
            FROM official_community_posts p JOIN official_accounts a ON a.id=p.author_id
            ${where}
            ORDER BY p.created_at DESC,p.id DESC LIMIT ${limitParameter} OFFSET ${offsetParameter}`, params)
        : await this.pool.query(`SELECT r.id,r.post_id,r.author_id,a.name AS author_name,r.body,
            r.created_at,r.deleted_at,r.hidden_at,r.hidden_reason
            FROM official_community_replies r
            JOIN official_accounts a ON a.id=r.author_id
            JOIN official_community_posts parent ON parent.id=r.post_id
            ${where}
            ORDER BY r.created_at DESC,r.id DESC LIMIT ${limitParameter} OFFSET ${offsetParameter}`, params)
      return result.rows
    }

    const postRows = kind === 'replies' ? [] : await queryRows('post')
    const replyRows = kind === 'posts' ? [] : await queryRows('reply')
    return {
      more: postRows.length > 100 || replyRows.length > 100,
      posts: postRows.slice(0, 100).map(row => ({
        id: row.id,
        author: { id: row.author_id, name: row.author_name },
        kind: row.kind,
        title: row.title,
        body: row.body,
        ...(row.room_code === null ? {} : { roomCode: row.room_code }),
        createdAt: iso(row.created_at),
        deleted: !!row.deleted_at,
        hidden: !!row.hidden_at,
        hiddenReason: row.hidden_reason ?? undefined,
      })),
      replies: replyRows.slice(0, 100).map(row => ({
        id: row.id,
        postId: row.post_id,
        author: { id: row.author_id, name: row.author_name },
        body: row.body,
        createdAt: iso(row.created_at),
        deleted: !!row.deleted_at,
        hidden: !!row.hidden_at,
        hiddenReason: row.hidden_reason ?? undefined,
      })),
    }
  }

  async administer(action: string, value: unknown, reasonValue?: unknown) {
    const reason = plainText(reasonValue ?? '', { field: '操作原因', max: 300, required: false })
    if (!reason) throw new OfficialError('请填写1–300字的操作原因')
    const rawValue = plainText(value, { field: '审核目标', max: 160, printable: true })
    const restoring = action === 'community-restore-post' || action === 'community-restore-reply'
    let kind: 'post' | 'reply'
    let id: string
    if (action === 'community-hide') {
      const separator = rawValue.indexOf(':')
      if (separator < 1) throw new OfficialError('审核目标无效')
      const prefix = rawValue.slice(0, separator)
      if (prefix !== 'post' && prefix !== 'reply') throw new OfficialError('审核目标无效')
      kind = prefix
      id = accountId(rawValue.slice(separator + 1))
    } else if (action === 'community-hide-post' || action === 'community-hide-reply'
      || action === 'community-restore-post' || action === 'community-restore-reply') {
      kind = action.endsWith('-post') ? 'post' : 'reply'
      id = accountId(rawValue)
    } else throw new OfficialError('未知社区管理操作')
    await transaction(this.pool, async client => {
      const table = kind === 'post' ? 'official_community_posts' : 'official_community_replies'
      const current = (await client.query<{ id: string; deleted_at: Date | null; hidden_at: Date | null }>(
        `SELECT id,deleted_at,hidden_at FROM ${table} WHERE id=$1 FOR UPDATE`, [id],
      )).rows[0]
      if (!current) throw new OfficialError('审核目标不存在', 404)
      if (restoring) {
        if (current.deleted_at) throw new OfficialError('作者已删除的内容不能恢复', 409)
        if (!current.hidden_at) throw new OfficialError('审核目标未隐藏', 409)
        await client.query(`UPDATE ${table}
          SET hidden_at=NULL,hidden_by=NULL,hidden_reason=NULL WHERE id=$1`, [id])
      } else {
        await client.query(`UPDATE ${table}
          SET hidden_at=coalesce(hidden_at,now()),hidden_by='local-admin',hidden_reason=$2
          WHERE id=$1`, [id, reason])
      }
      const auditValue = action === 'community-hide' ? rawValue : id
      await client.query('INSERT INTO official_audit(action,detail) VALUES($1,$2)', [action, { value: auditValue, reason }])
    })
  }
}

// The short name is convenient for callers while preserving a descriptive
// class name for stack traces and tests.
export const Community = CommunityService
