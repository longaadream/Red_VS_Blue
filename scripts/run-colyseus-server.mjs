import server, { journal, restoreProductRooms } from '../colyseus.config.ts'

const SHUTDOWN_REQUEST = 'rvb:battle-authority:shutdown'
const SHUTDOWN_RESULT = 'rvb:battle-authority:shutdown-result'

const port = positiveInteger(process.env.RVB_COLYSEUS_PORT, 2567)
const host = process.env.RVB_COLYSEUS_HOST?.trim() || '127.0.0.1'

await server.listen(port, host)
const restoredRoomIds = await restoreProductRooms()
console.log(`[colyseus] RED-161 product authority listening on http://${host}:${port}`)
console.log(`[colyseus] health: http://${host}:${port}/healthz`)
if (restoredRoomIds.length > 0) console.log(`[colyseus] restored ${restoredRoomIds.length} durable room(s)`)

let shuttingDown = false
async function shutdown(requestId) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    // Colyseus currently swallows Room.onDispose/onBeforeShutdown errors.
    // Establish our own fallible durability barrier before acknowledging the
    // Electron parent, so PostgreSQL cannot be stopped after a false success.
    await journal.close()
    await server.gracefullyShutdown(false)
    if (requestId && process.send) process.send({ type: SHUTDOWN_RESULT, requestId, ok: true })
    process.exit(0)
  } catch (error) {
    if (requestId && process.send) {
      process.send({ type: SHUTDOWN_RESULT, requestId, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    process.exitCode = 1
  }
}

process.on('message', message => {
  if (message?.type === SHUTDOWN_REQUEST) void shutdown(message.requestId)
})
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
