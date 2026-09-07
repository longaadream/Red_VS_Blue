export const MAX_PAYLOAD = 2 * 1024 * 1024
export const MAX_BUFFERED = 8 * 1024 * 1024
export const CHANNEL_TIMEOUT_MS = 15000

// Only the game catalog, admission, rooms and Colyseus session endpoints.
// No arbitrary URL, Next API, filesystem, PostgreSQL or administration access.
export function allowedGamePath(method, path) {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/')
    || /[\\\r\n#]/.test(path) || /%2e|%2f|%5c/i.test(path) || path.includes('..')) return false
  const pathname = path.split('?')[0]
  if (method === 'WS') return /^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(pathname)
  if (method === 'POST') return /^\/matchmake\/(joinById|reconnect)\/[a-zA-Z0-9_-]+$/.test(pathname)
  if (method !== 'GET') return false
  return /^\/(healthz|api\/ping|admission\/challenge|catalog\/(identity|maps|pieces|skills)|catalog\/cards\/[a-zA-Z0-9_-]+|rooms|rooms\/[a-zA-Z0-9_-]+|battle-reports|battle-reports\/[a-zA-Z0-9_-]+)$/.test(pathname)
}

export function sendPacket(socket, packet) {
  if (socket.readyState !== 1) return false
  const data = JSON.stringify(packet)
  if (Buffer.byteLength(data) > MAX_PAYLOAD || socket.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED) {
    socket.close(1013, 'Relay capacity exceeded')
    return false
  }
  socket.send(data)
  return true
}

export function readPacket(data) {
  if (data.length > MAX_PAYLOAD) throw new Error('Relay packet too large')
  const packet = JSON.parse(data.toString())
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || typeof packet.type !== 'string') throw new Error('Invalid relay packet')
  return packet
}
