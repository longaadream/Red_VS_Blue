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
