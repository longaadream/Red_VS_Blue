import server, { journal, restoreProductRooms } from '../colyseus.config.ts'
import { openHostTunnel } from '../lib/server/relay/host-tunnel.ts'

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
let relayTunnel = null
let relayGeneration = 0
let relayPublishing = false

async function handleRelayControl(message) {
  const reply = value => process.send?.({ type: 'rvb:relay:result', requestId: message.requestId, ...value })
  if (message.action === 'status') return reply({ ok: true, published: relayTunnel?.published ?? null })
  if (message.action === 'stop') {
    relayGeneration++
    relayTunnel?.close(); relayTunnel = null
    return reply({ ok: true, published: null })
  }
  if (message.action !== 'publish' || shuttingDown || relayPublishing) return reply({ ok: false, error: '主机正在切换连接，请稍后重试' })
  relayPublishing = true
  const generation = ++relayGeneration
  relayTunnel?.close(); relayTunnel = null
  try {
    const tunnel = await openHostTunnel({
      relayUrl: String(message.relayUrl || ''), localOrigin: `http://127.0.0.1:${port}`,
      name: String(message.name || '').slice(0, 60), visible: message.visible === true,
      publishKey: String(message.publishKey || ''),
      onClosed: () => { if (generation === relayGeneration) relayTunnel = null },
    })
    if (generation !== relayGeneration || shuttingDown) { tunnel.close(); throw new Error('发布已取消') }
    relayTunnel = tunnel
    reply({ ok: true, published: tunnel.published })
  } catch (error) { reply({ ok: false, error: error instanceof Error ? error.message : '发布失败' }) }
  finally { relayPublishing = false }
}

async function shutdown(requestId) {
  if (shuttingDown) return
  shuttingDown = true
  relayGeneration++
  relayTunnel?.close(); relayTunnel = null
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
  if (message?.type === 'rvb:relay:control') void handleRelayControl(message)
})
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
