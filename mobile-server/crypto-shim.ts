import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

export function randomUUID(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  globalThis.crypto?.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytesToHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function randomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new RangeError('maxExclusive must be a positive integer')
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % maxExclusive)
  const value = new Uint32Array(1)
  do { globalThis.crypto.getRandomValues(value) } while (value[0] >= limit)
  return value[0] % maxExclusive
}

export function createHash(algorithm: string) {
  if (algorithm.toLowerCase() !== 'sha256') throw new Error(`Unsupported hash: ${algorithm}`)
  const chunks: Uint8Array[] = []
  return {
    update(value: string | Uint8Array) { chunks.push(typeof value === 'string' ? encoder.encode(value) : value); return this },
    digest(encoding: 'hex') {
      if (encoding !== 'hex') throw new Error('Android crypto shim only supports hex digests')
      const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
      const input = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length }
      return bytesToHex(sha256(input))
    },
  }
}
