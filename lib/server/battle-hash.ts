import { createHash } from 'node:crypto'

import { installSha256HexProvider } from '../game/battle-trace'

export type BattleHashEnvironment = Readonly<Record<string, string | undefined>>

export function nodeSha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Server-only startup wiring. The opt-out is checked before provider
 * installation so RVB_BATTLE_NATIVE_SHA=0 retains the pure JS implementation.
 */
export function installNativeBattleSha256(
  environment: BattleHashEnvironment = process.env,
): boolean {
  if (environment.RVB_BATTLE_NATIVE_SHA === '0') return false
  return installSha256HexProvider(nodeSha256Hex)
}
