import { Pool } from 'pg'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { ACCOUNT_SCHEMA } from '@/lib/server/official/accounts'
import { Community } from '@/lib/server/official/community'
import { RoomInvitations } from '@/lib/server/official/room-invitations'

const url = process.env.RVB_TEST_POSTGRES_URL
describe.skipIf(!url)('RED-244 persisted room invitation permissions', () => {
  let base: Pool, pool: Pool, community: Community, invites: RoomInvitations
  const schema = `red244_invites_${process.pid}_${Date.now()}`
  beforeAll(async () => {
    base = new Pool({ connectionString: url })
    await base.query(`CREATE SCHEMA ${schema}`)
    const scoped = new URL(url!); scoped.searchParams.set('options', `-c search_path=${schema}`)
    pool = new Pool({ connectionString: scoped.toString() })
    await pool.query(ACCOUNT_SCHEMA)
    for (const id of ['alice','bob','outsider']) await pool.query('INSERT INTO official_accounts(id,email,name,password_hash) VALUES($1,$2,$1,$3)', [id, `${id}@example.test`, 'unused'])
    community = new Community(pool); await community.initialize()
    invites = new RoomInvitations(pool); await invites.initialize()
    await community.request('alice','bob'); await community.accept('bob','alice')
  })
  afterAll(async () => { await pool?.end(); await base?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await base?.end() })
  it('rejects unknown fields, non-friends and arbitrary host URLs', async () => {
    await expect(invites.send('alice',{targetAccountId:'outsider',hostId:'abc123',roomId:'room'})).rejects.toMatchObject({status:403})
    await expect(invites.send('alice',{targetAccountId:'bob',hostId:'https://elsewhere.test',roomId:'room'})).rejects.toMatchObject({status:400})
    await expect(invites.send('alice',{targetAccountId:'bob',hostId:'abc123',roomId:'room',senderId:'outsider'})).rejects.toMatchObject({status:400})
  })
  it('persists a single pending invitation and only lets its recipient accept once', async () => {
    const input = { targetAccountId:'bob',hostId:'abc123',roomId:'room-a' }
    const [a,b] = await Promise.all([invites.send('alice',input),invites.send('alice',input)])
    expect(a.id).toBe(b.id)
    expect((await new RoomInvitations(pool).list('bob')).invitations).toHaveLength(1)
    expect((await invites.list('outsider')).invitations).toEqual([])
    await expect(invites.respond('outsider',a.id,true)).rejects.toMatchObject({status:404})
    const responses = await Promise.allSettled([invites.respond('bob',a.id,true),invites.respond('bob',a.id,true)])
    expect(responses.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(responses.find(r=>r.status==='fulfilled')).toMatchObject({value:{hostId:'abc123',roomId:'room-a'}})
    expect((await invites.list('bob')).invitations).toEqual([])
  })
  it('hides expired and blocked invitations and rejects their acceptance', async () => {
    const expired = await invites.send('alice',{targetAccountId:'bob',hostId:'abc123',roomId:'expired'})
    await pool.query("UPDATE official_room_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id])
    await expect(invites.respond('bob',expired.id,true)).rejects.toMatchObject({status:409})
    const blocked = await invites.send('alice',{targetAccountId:'bob',hostId:'abc123',roomId:'blocked'})
    await community.block('bob','alice')
    expect((await invites.list('bob')).invitations).toEqual([])
    await expect(invites.respond('bob',blocked.id,true)).rejects.toMatchObject({status:403})
    await expect(invites.send('alice',{targetAccountId:'bob',hostId:'abc123',roomId:'again'})).rejects.toMatchObject({status:403})
  })
})
