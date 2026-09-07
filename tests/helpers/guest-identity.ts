import { createHash, generateKeyPairSync, sign } from 'node:crypto'
export function guestIdentity() {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  const playerId = createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 8)
  return { playerId, proof(nonce: string, roomId: string) {
    const payload = { type: 'rvb-colyseus-admission-v1', nonce, playerId, roomId }
    return { payload, publicKey, signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('hex') }
  } }
}
