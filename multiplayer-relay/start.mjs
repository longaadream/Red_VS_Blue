import { createRelay } from './relay.mjs'

const port = Number(process.env.PORT || 8080)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
const relay = createRelay({
  publicOrigin: process.env.RVB_RELAY_PUBLIC_ORIGIN || `http://127.0.0.1:${port}`,
  publishKey: process.env.RVB_RELAY_PUBLISH_KEY || '',
  trustedProxyAddresses: (process.env.RVB_RELAY_TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean),
})
relay.server.listen(port, process.env.HOST || '127.0.0.1', () => console.info(`[host-relay] listening on port ${port}`))
let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return
  closing = true
  await relay.close()
})
