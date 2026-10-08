import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { digest } from '@/lib/server/official/accounts'
import { createOfficialServer } from '@/lib/server/official/server'
import { findFreePort } from '@/electron-client/local-port'

const databaseUrl = process.env.RVB_TEST_POSTGRES_URL
const suite = describe.skipIf(!databaseUrl)

type Actor = {
  id: string
  email: string
  name: string
  token: string
}

type HttpResult<T> = {
  status: number
  body: T
  text: string
}

type CharacterCard = { id: string; name: string; image: string }
type PlayerCard = { id: string; name: string; avatar: CharacterCard | null }
type Profile = PlayerCard & {
  totalGames: number
  wins: number
  draws: number
  season: { id: string; name: string; rating: number; games: number; wins: number }
  favoriteRosters: { light: unknown; dark: unknown }
  recentMatches: unknown[]
}
type Invitation = {
  id: string
  sender: { id: string; name: string }
  expiresAt: string
}
type Invitations = { invitations: Invitation[] }

suite('RED-244 player profiles and invitations over the official HTTP server', () => {
  let app: Awaited<ReturnType<typeof createOfficialServer>> | undefined
  let basePool: Pool | undefined
  let scopedDatabaseUrl = ''
  let origin = ''
  let schema = ''
  let actors: Actor[] = []

  beforeAll(async () => {
    schema = `red244_http_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    basePool = new Pool({ connectionString: databaseUrl!, max: 4 })
    await basePool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
    scopedDatabaseUrl = withSearchPath(databaseUrl!, schema)
    app = await createOfficialServer({ databaseUrl: scopedDatabaseUrl, mail: async () => {} })
    const port = await findFreePort(39142)
    await app.start(port)
    origin = `http://127.0.0.1:${port}`
    actors = await seedActors(3)
    const [first, second] = [actors[0].id, actors[1].id].sort()
    await app.pool.query(`INSERT INTO official_community_friendships(
      account_low,account_high,status,requester_id
    ) VALUES($1,$2,'accepted',$3)`, [first, second, actors[0].id])
  }, 120_000)

  afterAll(async () => {
    await app?.close().catch(() => {})
    await basePool?.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => {})
    await basePool?.end().catch(() => {})
  }, 60_000)

  it('protects every profile endpoint, returns zero-history DTOs, and persists edits through restart', async () => {
    const [alice, bob] = actors
    const anonymousRequests: Array<[string, unknown?]> = [
      ['/official/players/catalog'],
      [`/official/players/cards?ids=${encodeURIComponent(alice.id)}`],
      [`/official/players/${alice.id}`],
      [`/official/players/${alice.id}/history`],
      ['/official/players/me', { name: '匿名' }],
      ['/official/character-stats'],
      ['/official/matches/no-history/replay'],
      ['/official/community/invitations'],
      ['/official/community/invitations', { targetAccountId: bob.id, hostId: 'a'.repeat(32), roomId: 'anon-room' }],
      ['/official/community/invitations/not-an-invitation/accept', {}],
      ['/official/community/invitations/not-an-invitation/decline', {}],
    ]
    for (const [route, body] of anonymousRequests) {
      expect((await request(undefined, route, body)).status, route).toBe(401)
    }

    const catalog = await request<{ characters: CharacterCard[]; resourceIdentity: Record<string, unknown> }>(
      alice,
      '/official/players/catalog',
    )
    expect(catalog.status).toBe(200)
    expect(catalog.body.characters.length).toBeGreaterThan(0)
    expect(catalog.body.resourceIdentity).toEqual(expect.any(Object))
    const avatar = catalog.body.characters[0]
    expect(avatar.image).toMatch(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:png|jpe?g|webp|gif|svg)$/i)

    const cards = await request<{ players: PlayerCard[] }>(
      bob,
      `/official/players/cards?ids=${encodeURIComponent(`${alice.id},${bob.id}`)}`,
    )
    expect(cards.status).toBe(200)
    expect(cards.body.players.map(player => player.id)).toEqual([alice.id, bob.id])
    expect(cards.body.players.every(player => !Object.hasOwn(player, 'email'))).toBe(true)
    expect(cards.text).not.toContain(alice.email)

    const profile = await request<{ profile: Profile }>(bob, `/official/players/${alice.id}`)
    expect(profile.status).toBe(200)
    expect(profile.text).not.toContain(alice.email)
    expect(profile.body.profile).toMatchObject({
      id: alice.id,
      name: alice.name,
      totalGames: 0,
      wins: 0,
      draws: 0,
      recentMatches: [],
    })
    expect(profile.body.profile.season).toMatchObject({ rating: 1000, games: 0, wins: 0 })
    expect(profile.body.profile).not.toHaveProperty('email')

    const history = await request<{ matches: unknown[]; nextCursor?: string }>(
      bob,
      `/official/players/${alice.id}/history`,
    )
    expect(history.status).toBe(200)
    expect(history.body.matches).toEqual([])
    expect(history.body).not.toHaveProperty('nextCursor')

    const stats = await request<{ matches: number; playerGames: number; characters: unknown[] }>(
      bob,
      '/official/character-stats',
    )
    expect(stats.status).toBe(200)
    expect(stats.body).toMatchObject({ matches: 0, playerGames: 0, characters: [] })

    const updatedAlice = await request<{ profile: Profile }>(alice, '/official/players/me', {
      name: '资料甲',
      avatarCharacterId: avatar.id,
    })
    expect(updatedAlice.status).toBe(200)
    expect(updatedAlice.body.profile).toMatchObject({
      id: alice.id,
      name: '资料甲',
      avatar: { id: avatar.id, image: avatar.image },
    })

    const invalidAvatar = await request(alice, '/official/players/me', {
      name: '资料甲',
      avatarCharacterId: 'https://example.invalid/avatar.png',
    })
    expect(invalidAvatar.status).toBe(400)
    const extraAccountId = await request(bob, '/official/players/me', {
      accountId: alice.id,
      name: '越权修改',
    })
    expect(extraAccountId.status).toBe(400)

    const updatedBob = await request<{ profile: Profile }>(bob, '/official/players/me', { name: '资料乙', avatarCharacterId: null })
    expect(updatedBob.status).toBe(200)
    expect(updatedBob.body.profile).toMatchObject({ id: bob.id, name: '资料乙', avatar: null })
    const aliceAfterBobEdit = await request<{ profile: Profile }>(bob, `/official/players/${alice.id}`)
    expect(aliceAfterBobEdit.body.profile.name).toBe('资料甲')

    await restartServer()
    const persisted = await request<{ profile: Profile }>(bob, `/official/players/${alice.id}`)
    expect(persisted.status).toBe(200)
    expect(persisted.body.profile).toMatchObject({ id: alice.id, name: '资料甲', avatar: { id: avatar.id } })
    const persistedCards = await request<{ players: PlayerCard[] }>(bob, `/official/players/cards?ids=${alice.id}`)
    expect(persistedCards.status).toBe(200)
    expect(persistedCards.body.players).toEqual([expect.objectContaining({ id: alice.id, name: '资料甲' })])
  }, 120_000)

  it('runs invitation send/list/accept/decline through the HTTP permission boundary', async () => {
    const [alice, bob, outsider] = actors
    const first = await request<{ id: string; expiresAt: string }>(alice, '/official/community/invitations', {
      targetAccountId: bob.id,
      hostId: 'a'.repeat(32),
      roomId: 'room-a',
    })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ id: expect.any(String), expiresAt: expect.any(String) })

    const pending = await request<Invitations>(bob, '/official/community/invitations')
    expect(pending.status).toBe(200)
    expect(pending.body.invitations).toEqual([expect.objectContaining({
      id: first.body.id,
      sender: { id: alice.id, name: '资料甲' },
    })])

    const outsiderAccept = await request(outsider, `/official/community/invitations/${first.body.id}/accept`, {})
    expect(outsiderAccept.status).toBeGreaterThanOrEqual(400)
    expect(outsiderAccept.body).toHaveProperty('error')

    const accepted = await request<{ hostId: string; roomId: string }>(bob, `/official/community/invitations/${first.body.id}/accept`, {})
    expect(accepted.status).toBe(200)
    expect(accepted.body).toEqual({ hostId: 'a'.repeat(32), roomId: 'room-a' })
    expect((await request<Invitations>(bob, '/official/community/invitations')).body.invitations).toEqual([])

    const second = await request<{ id: string }>(alice, '/official/community/invitations', {
      targetAccountId: bob.id,
      hostId: 'b'.repeat(32),
      roomId: 'room-b',
    })
    expect(second.status).toBe(200)
    const declined = await request<{ ok: boolean }>(bob, `/official/community/invitations/${second.body.id}/decline`, {})
    expect(declined.status).toBe(200)
    expect(declined.body).toEqual({ ok: true })
    expect((await request<Invitations>(bob, '/official/community/invitations')).body.invitations).toEqual([])
  }, 120_000)

  async function seedActors(count: number): Promise<Actor[]> {
    const suffix = randomUUID().slice(0, 8)
    const names = ['初始甲', '初始乙', '初始丙'] as const
    const seeded: Actor[] = []
    for (let index = 0; index < count; index += 1) {
      const id = `red244-http-${suffix}-${String.fromCharCode(97 + index)}`
      const actor = {
        id,
        email: `${id}@example.test`,
        name: names[index] ?? `初始${index}`,
        token: `red244-http-token-${suffix}-${index}-${randomUUID()}`,
      }
      await app!.pool.query(
        'INSERT INTO official_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
        [actor.id, actor.email, actor.name, 'fixture-password-hash'],
      )
      await app!.pool.query(
        'INSERT INTO official_sessions(token_hash,account_id) VALUES($1,$2)',
        [digest(actor.token), actor.id],
      )
      seeded.push(actor)
    }
    return seeded
  }

  async function request<T = Record<string, unknown>>(actor: Actor | undefined, route: string, body?: unknown): Promise<HttpResult<T>> {
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
    app = await createOfficialServer({ databaseUrl: scopedDatabaseUrl, mail: async () => {} })
    const port = await findFreePort(39142)
    await app.start(port)
    origin = `http://127.0.0.1:${port}`
  }
})

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString)
  url.searchParams.set('options', `-c search_path=${schema},public`)
  return url.toString()
}
