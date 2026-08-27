import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { pingRouter } from './routes/ping'
import { lobbyRouter } from './routes/lobby'
import { roomsRouter } from './routes/rooms'
import { leaderboardRouter } from './routes/leaderboard'
import { wsHandler } from './ws/handler'
import { store } from './store'
import { STANDALONE_SELECTABLE_MAP_CATALOG, type WsData } from './types'

const app = new Hono()

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }))

app.route('/api/ping', pingRouter)
app.route('/api/lobby', lobbyRouter)
app.route('/api/rooms', roomsRouter)
app.route('/api/leaderboard', leaderboardRouter)
app.get('/api/maps', c => c.json({ maps: STANDALONE_SELECTABLE_MAP_CATALOG }))

app.all('*', c => c.json({ error: 'not found' }, 404))

const PORT = Number(process.env.PORT) || 3000

await store.loadFromDb()

const server = Bun.serve<WsData>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade: /ws/rooms/:roomId
    if (url.pathname.startsWith('/ws/rooms/')) {
      const roomId = url.pathname.split('/')[3]
      if (!roomId) return new Response('missing roomId', { status: 400 })

      const upgraded = server.upgrade<WsData>(req, { data: { roomId } })
      if (upgraded) return undefined
      return new Response('WebSocket upgrade failed', { status: 500 })
    }

    return app.fetch(req)
  },

  websocket: wsHandler,
})

console.log(`[relay] Listening on http://localhost:${server.port}`)
console.log(`[relay] WebSocket on ws://localhost:${server.port}/ws/rooms/:roomId`)
