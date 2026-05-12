import { Hono } from 'hono'

export const pingRouter = new Hono()

pingRouter.get('/', c =>
  c.json({ name: 'RED vs BLUE Relay Server', status: 'ok', ts: Date.now() })
)
