import { Hono } from 'hono'
import { db } from '../db/client'

export const leaderboardRouter = new Hono()

// GET /api/leaderboard — top 100 by rating
leaderboardRouter.get('/', async c => {
  const players = await db.leaderboardPlayer.findMany({
    orderBy: { rating: 'desc' },
    take: 100,
    select: { id: true, displayName: true, rating: true, wins: true, losses: true },
  })
  return c.json({ players })
})

// POST /api/leaderboard/register — upload RSA public key + profile
leaderboardRouter.post('/register', async c => {
  const body = await c.req.json<{
    playerId: string
    displayName: string
    publicKey: string
  }>()

  if (!body.playerId || !body.displayName || !body.publicKey) {
    return c.json({ error: 'missing fields' }, 400)
  }

  const player = await db.leaderboardPlayer.upsert({
    where: { id: body.playerId },
    create: {
      id: body.playerId,
      displayName: body.displayName,
      publicKey: body.publicKey,
    },
    update: {
      displayName: body.displayName,
      publicKey: body.publicKey,
    },
  })

  return c.json({ id: player.id, rating: player.rating })
})

// POST /api/leaderboard/record — verify and apply a battle record to ratings
leaderboardRouter.post('/record', async c => {
  const body = await c.req.json<{ recordId: string }>()
  if (!body.recordId) return c.json({ error: 'missing recordId' }, 400)

  const record = await db.battleRecord.findUnique({ where: { id: body.recordId } })
  if (!record) return c.json({ error: 'record not found' }, 404)
  if (record.verified) return c.json({ error: 'already verified' }, 400)

  const [winner, loser] = await Promise.all([
    db.leaderboardPlayer.findUnique({ where: { id: record.winnerId } }),
    db.leaderboardPlayer.findUnique({ where: { id: record.loserId } }),
  ])

  // Both must be registered on the leaderboard
  if (!winner || !loser) {
    return c.json({ error: 'one or both players not registered on leaderboard' }, 400)
  }

  // Elo calculation (K=32)
  const K = 32
  const expected = 1 / (1 + Math.pow(10, (loser.rating - winner.rating) / 400))
  const delta = Math.round(K * (1 - expected))

  await db.$transaction([
    db.leaderboardPlayer.update({
      where: { id: winner.id },
      data: { rating: { increment: delta }, wins: { increment: 1 } },
    }),
    db.leaderboardPlayer.update({
      where: { id: loser.id },
      data: { rating: { decrement: delta }, losses: { increment: 1 } },
    }),
    db.battleRecord.update({
      where: { id: record.id },
      data: { verified: true },
    }),
  ])

  return c.json({ ok: true, ratingDelta: delta })
})
