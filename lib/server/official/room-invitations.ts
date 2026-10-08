import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { OfficialError, transaction } from './accounts'

export const ROOM_INVITATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS official_room_invitations (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1 CHECK(version=1),
 sender_id TEXT NOT NULL REFERENCES official_accounts(id),
 receiver_id TEXT NOT NULL REFERENCES official_accounts(id),
 host_id TEXT NOT NULL, room_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '5 minutes'),
 CHECK(sender_id<>receiver_id)
);
CREATE INDEX IF NOT EXISTS official_room_invitations_inbox ON official_room_invitations(receiver_id,expires_at);
CREATE INDEX IF NOT EXISTS official_room_invitations_sender ON official_room_invitations(sender_id,created_at);
`

function identifier(value: unknown, field: string, pattern = /^[A-Za-z0-9_-]{1,128}$/) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new OfficialError(`${field}无效`)
  return value
}

async function friends(client: PoolClient, sender: string, receiver: string) {
  if (sender === receiver) throw new OfficialError('不能邀请自己')
  const pair = [sender, receiver].sort()
  // Same lock order as Community mutations, so block/remove cannot race acceptance.
  const accounts = await client.query('SELECT id FROM official_accounts WHERE id=ANY($1) AND NOT banned ORDER BY id FOR UPDATE', [pair])
  if (accounts.rowCount !== 2) throw new OfficialError('该好友暂不可邀请', 403)
  const result = await client.query(`SELECT 1 FROM official_community_friendships
    WHERE account_low=$1 AND account_high=$2 AND status='accepted'
    AND NOT EXISTS(SELECT 1 FROM official_community_blocks WHERE
      (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))`, pair)
  if (!result.rowCount) throw new OfficialError('只可邀请未屏蔽的好友', 403)
}

export class RoomInvitations {
  constructor(private readonly pool: Pool) {}
  async initialize() { await this.pool.query(ROOM_INVITATIONS_SCHEMA) }
  async send(sender: string, value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfficialError('邀请格式无效')
    const input = value as Record<string, unknown>
    if (Object.keys(input).some(key => !['targetAccountId','hostId','roomId'].includes(key))) throw new OfficialError('邀请包含未知字段')
    const receiver = identifier(input.targetAccountId, '好友')
    const host = identifier(input.hostId, '主机', /^[a-f0-9]{1,128}$/)
    const room = identifier(input.roomId, '房间')
    return transaction(this.pool, async client => {
      await friends(client, sender, receiver)
      const recent = await client.query(`SELECT count(*)::int AS count FROM official_room_invitations
        WHERE sender_id=$1 AND created_at>now()-interval '1 minute'`, [sender])
      if (recent.rows[0].count >= 5) throw new OfficialError('邀请发送过于频繁，请稍后重试', 429)
      const duplicate = await client.query(`SELECT id,expires_at FROM official_room_invitations
        WHERE sender_id=$1 AND receiver_id=$2 AND host_id=$3 AND room_id=$4 AND status='pending' AND expires_at>now()`, [sender,receiver,host,room])
      if (duplicate.rowCount) return { id: duplicate.rows[0].id, expiresAt: new Date(duplicate.rows[0].expires_at).toISOString() }
      const id = randomUUID()
      const result = await client.query(`INSERT INTO official_room_invitations(id,sender_id,receiver_id,host_id,room_id)
        VALUES($1,$2,$3,$4,$5) RETURNING expires_at`, [id,sender,receiver,host,room])
      return { id, expiresAt: new Date(result.rows[0].expires_at).toISOString() }
    })
  }
  async list(receiver: string) {
    const result = await this.pool.query(`SELECT i.id,i.expires_at,a.id AS sender_id,a.name FROM official_room_invitations i
      JOIN official_accounts a ON a.id=i.sender_id AND NOT a.banned
      JOIN official_community_friendships f ON f.account_low=LEAST(i.sender_id,i.receiver_id)
        AND f.account_high=GREATEST(i.sender_id,i.receiver_id) AND f.status='accepted'
      WHERE i.receiver_id=$1 AND i.status='pending' AND i.expires_at>now()
      AND NOT EXISTS(SELECT 1 FROM official_community_blocks b WHERE
        (b.blocker_id=i.sender_id AND b.blocked_id=i.receiver_id) OR (b.blocker_id=i.receiver_id AND b.blocked_id=i.sender_id))
      ORDER BY i.created_at DESC,i.id DESC LIMIT 50`, [receiver])
    return { invitations: result.rows.map(row => ({ id: row.id, sender: { id: row.sender_id, name: row.name }, expiresAt: new Date(row.expires_at).toISOString() })) }
  }
  async respond(receiver: string, invitationId: unknown, accept: boolean) {
    const id = identifier(invitationId, '邀请')
    return transaction(this.pool, async client => {
      const row = (await client.query('SELECT sender_id FROM official_room_invitations WHERE id=$1 AND receiver_id=$2', [id,receiver])).rows[0]
      if (!row) throw new OfficialError('邀请不存在或已失效', 404)
      await friends(client, row.sender_id, receiver)
      const updated = await client.query(`UPDATE official_room_invitations SET status=$3
        WHERE id=$1 AND receiver_id=$2 AND status='pending' AND expires_at>now() RETURNING host_id,room_id`, [id,receiver,accept?'accepted':'declined'])
      if (!updated.rowCount) throw new OfficialError('邀请已处理或已过期，请好友重新邀请', 409)
      // This is a destination hint, never a join capability. The client still performs
      // resource-version, room-capacity and signed membership checks with the host.
      return accept ? { hostId: updated.rows[0].host_id, roomId: updated.rows[0].room_id } : { ok: true }
    })
  }
}
