import { createHash, createHmac } from 'crypto'

export interface PlayerIdentity {
  playerId: string
  publicKey: string
  displayName: string
  sign(payload: unknown): Promise<string>
}

export interface IdentityProvider {
  createIdentity(label: string): Promise<PlayerIdentity>
}

export class DebugIdentityProvider implements IdentityProvider {
  constructor(private readonly namespace = 'rvb-debug') {}

  async createIdentity(label: string): Promise<PlayerIdentity> {
    const secret = `${this.namespace}:${label}`
    const publicKey = createHash('sha256').update(secret).digest('hex')
    const playerId = createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 8)

    return {
      playerId,
      publicKey,
      displayName: `Debug ${label}`,
      async sign(payload: unknown) {
        return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')
      },
    }
  }
}
