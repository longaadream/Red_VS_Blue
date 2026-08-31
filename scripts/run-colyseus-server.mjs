import { server } from '../colyseus.config.ts'

const port = positiveInteger(process.env.RVB_COLYSEUS_PORT, 2567)
const host = process.env.RVB_COLYSEUS_HOST?.trim() || '127.0.0.1'

await server.listen(port, host)
console.log(`[colyseus] RED-160 candidate listening on ws://${host}:${port}`)
console.log(`[colyseus] health: http://${host}:${port}/healthz`)

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
