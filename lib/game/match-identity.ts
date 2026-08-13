/** Match identity is deliberately separate from piece content metadata. */
export type PlayerSeat = 'red' | 'blue'
export type ContentAlignment = 'light' | 'dark'

export function isPlayerSeat(value: unknown): value is PlayerSeat {
  return value === 'red' || value === 'blue'
}

export function normalizeContentAlignment(value: unknown): ContentAlignment | undefined {
  if (value === 'light' || value === 'good') return 'light'
  if (value === 'dark' || value === 'evil') return 'dark'
  return undefined
}

/** ownerPlayerId is the sole ally/enemy discriminator. */
export function areAllies(firstOwnerPlayerId: string, secondOwnerPlayerId: string): boolean {
  return firstOwnerPlayerId === secondOwnerPlayerId
}

export function areEnemies(firstOwnerPlayerId: string, secondOwnerPlayerId: string): boolean {
  return !areAllies(firstOwnerPlayerId, secondOwnerPlayerId)
}
