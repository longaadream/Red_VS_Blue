export async function register() {
  // Legacy raw player WebSocket authority is an explicit compatibility-only
  // runtime. Product candidates use Colyseus and never start this ingress.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.ENABLE_LEGACY_PLAYER_WS === '1') {
    const { startWsServer } = await import('./lib/ws-server')
    await startWsServer()
  }
}
