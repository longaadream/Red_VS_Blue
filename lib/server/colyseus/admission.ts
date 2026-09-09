import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'

export function createAdmissionAuthority() {
  const challenges = new Map<string, number>()
  return {
    challenge() {
      const now = Date.now()
      for (const [nonce, expires] of challenges) if (expires <= now) challenges.delete(nonce)
      if (challenges.size >= 512) throw new Error('Admission busy')
      const nonce = randomBytes(24).toString('hex')
      challenges.set(nonce, now + 30000)
      return { nonce }
    },
    authenticate(playerId: string, roomId: string, proof: unknown): string {
      const fail = () => { throw Object.assign(new Error('玩家身份验证失败，请重新连接'), { code: 'PLAYER_AUTH_INVALID' }) }
      if (!proof || typeof proof !== 'object') return fail()
      const { payload, publicKey, signature } = proof as { payload?: { type?: string; nonce?: string; playerId?: string; roomId?: string }; publicKey?: string; signature?: string }
      if (!payload || typeof payload.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(publicKey ?? '') || !/^[a-f0-9]{128}$/.test(signature ?? '')) return fail()
      const expiry = challenges.get(payload.nonce)
      challenges.delete(payload.nonce)
      if (!expiry || expiry <= Date.now() || payload.type !== 'rvb-colyseus-admission-v1' || payload.playerId !== playerId || payload.roomId !== roomId) return fail()
      const rawKey = Buffer.from(publicKey!, 'hex')
      if (createHash('sha256').update(rawKey).digest('hex').slice(0, 8) !== playerId) return fail()
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), format: 'der', type: 'spki' })
      if (!verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature!, 'hex'))) return fail()
      return publicKey!
    },
  }
}
