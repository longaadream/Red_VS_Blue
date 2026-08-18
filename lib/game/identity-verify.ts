// Ed25519 identity verification for Node.js (Next.js API routes).
// Uses globalThis.crypto.subtle (available in Node 18+).

function _hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2)
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return b
}

function _bytesToHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
}

async function _derivedId(publicKeyHex: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', _hexToBytes(publicKeyHex))
  return _bytesToHex(new Uint8Array(hash)).slice(0, 8)
}

async function _verify(payload: unknown, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'raw', _hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']
    )
    const msg = new TextEncoder().encode(JSON.stringify(payload))
    return globalThis.crypto.subtle.verify('Ed25519', key, _hexToBytes(signatureHex), msg)
  } catch { return false }
}

export interface BattleActionAuthEnvelope {
  publicKey: string
  payload: {
    type: 'battle-action'
    roomId: string
    playerId: string
    action: unknown
    timestamp: number
  }
  signature: string
}

export interface BattleSubscribeAuthEnvelope {
  publicKey: string
  payload: {
    type: 'battle-subscribe'
    roomId: string
    playerId: string
    timestamp: number
  }
  signature: string
}

export class BattleActionAuthError extends Error {
  code: 'BATTLE_AUTH_REQUIRED' | 'BATTLE_AUTH_INVALID' | 'BATTLE_AUTH_EXPIRED'

  constructor(code: BattleActionAuthError['code'], message: string) {
    super(message)
    this.name = 'BattleActionAuthError'
    this.code = code
  }
}

export class BattleSubscribeAuthError extends Error {
  code: 'SUBSCRIBE_AUTH_REQUIRED' | 'SUBSCRIBE_AUTH_INVALID' | 'SUBSCRIBE_AUTH_EXPIRED'

  constructor(code: BattleSubscribeAuthError['code'], message: string) {
    super(message)
    this.name = 'BattleSubscribeAuthError'
    this.code = code
  }
}

export async function verifyBattleActionAuth(
  candidate: unknown,
  expected: { roomId: string; action: unknown; now?: number },
): Promise<{ playerId: string }> {
  if (!candidate || typeof candidate !== 'object') {
    throw new BattleActionAuthError('BATTLE_AUTH_REQUIRED', 'A signed battle action identity is required')
  }
  const auth = candidate as Partial<BattleActionAuthEnvelope>
  const payload = auth.payload
  if (
    typeof auth.publicKey !== 'string'
    || typeof auth.signature !== 'string'
    || !payload
    || typeof payload !== 'object'
  ) {
    throw new BattleActionAuthError('BATTLE_AUTH_REQUIRED', 'A complete signed battle action identity is required')
  }

  const playerId = normalizeIdentityPart(payload.playerId)
  const roomId = normalizeIdentityPart(payload.roomId)
  if (
    payload.type !== 'battle-action'
    || !playerId
    || roomId !== normalizeIdentityPart(expected.roomId)
    || !Number.isSafeInteger(payload.timestamp)
    || JSON.stringify(payload.action) !== JSON.stringify(expected.action)
  ) {
    throw new BattleActionAuthError('BATTLE_AUTH_INVALID', 'Signed battle action payload does not match the request')
  }

  const now = expected.now ?? Date.now()
  if (Math.abs(now - payload.timestamp) > 60_000) {
    throw new BattleActionAuthError('BATTLE_AUTH_EXPIRED', 'Signed battle action identity has expired')
  }
  if (await _derivedId(auth.publicKey) !== playerId) {
    throw new BattleActionAuthError('BATTLE_AUTH_INVALID', 'Public key does not match the signed battle player')
  }
  if (!await _verify(payload, auth.signature, auth.publicKey)) {
    throw new BattleActionAuthError('BATTLE_AUTH_INVALID', 'Invalid battle action signature')
  }
  return { playerId }
}

export async function verifyBattleSubscribeAuth(
  candidate: unknown,
  expected: { roomId: string; playerId?: string; now?: number },
): Promise<{ playerId: string; publicKey: string }> {
  if (!candidate || typeof candidate !== 'object') {
    throw new BattleSubscribeAuthError('SUBSCRIBE_AUTH_REQUIRED', 'A signed WebSocket identity is required')
  }
  const auth = candidate as Partial<BattleSubscribeAuthEnvelope>
  const payload = auth.payload
  if (
    typeof auth.publicKey !== 'string'
    || typeof auth.signature !== 'string'
    || !payload
    || typeof payload !== 'object'
  ) {
    throw new BattleSubscribeAuthError('SUBSCRIBE_AUTH_REQUIRED', 'A complete signed WebSocket identity is required')
  }

  const playerId = normalizeIdentityPart(payload.playerId)
  const roomId = normalizeIdentityPart(payload.roomId)
  const expectedPlayerId = expected.playerId == null ? playerId : normalizeIdentityPart(expected.playerId)
  if (
    payload.type !== 'battle-subscribe'
    || !playerId
    || playerId !== expectedPlayerId
    || roomId !== normalizeIdentityPart(expected.roomId)
    || !Number.isSafeInteger(payload.timestamp)
  ) {
    throw new BattleSubscribeAuthError('SUBSCRIBE_AUTH_INVALID', 'Signed WebSocket identity does not match the subscription')
  }

  const now = expected.now ?? Date.now()
  if (Math.abs(now - payload.timestamp) > 60_000) {
    throw new BattleSubscribeAuthError('SUBSCRIBE_AUTH_EXPIRED', 'Signed WebSocket identity has expired')
  }
  if (await _derivedId(auth.publicKey) !== playerId) {
    throw new BattleSubscribeAuthError('SUBSCRIBE_AUTH_INVALID', 'Public key does not match the subscribed player')
  }
  if (!await _verify(payload, auth.signature, auth.publicKey)) {
    throw new BattleSubscribeAuthError('SUBSCRIBE_AUTH_INVALID', 'Invalid WebSocket subscription signature')
  }
  return { playerId, publicKey: auth.publicKey.toLowerCase() }
}

function normalizeIdentityPart(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

// Returns null if valid (or no auth fields present), error string otherwise.
export async function verifyJoinAuth(body: Record<string, unknown>): Promise<string | null> {
  const { publicKey, payload, signature } = body as {
    publicKey?: string
    payload?: Record<string, unknown>
    signature?: string
  }
  if (!publicKey || !payload || !signature) return null // absent = backwards-compatible

  const playerId = payload.playerId as string
  if (await _derivedId(publicKey) !== playerId) return 'Public key does not match player ID'

  const ts = payload.timestamp as number
  if (!ts || Math.abs(Date.now() - ts) > 60000) return 'Request expired'

  if (!await _verify(payload, signature, publicKey)) return 'Invalid signature'
  return null
}

export async function verifyRecordSignature(
  record: Record<string, unknown>,
  signatureHex: string,
  publicKeyHex: string,
): Promise<boolean> {
  return _verify(record, signatureHex, publicKeyHex)
}

export async function derivePlayerId(publicKeyHex: string): Promise<string> {
  return _derivedId(publicKeyHex)
}
