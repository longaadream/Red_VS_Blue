import { guestIdentity } from '../helpers/guest-identity'
import { expect, it, vi } from 'vitest'
import { createAdmissionAuthority } from '@/lib/server/colyseus/admission'

it('binds a one-use expiring challenge to the actual key, player and room', () => {
  const authority = createAdmissionAuthority(), guest = guestIdentity()
  const proof = guest.proof(authority.challenge().nonce, 'room')
  expect(authority.authenticate(guest.playerId, 'room', proof)).toBe(proof.publicKey)
  expect(() => authority.authenticate(guest.playerId, 'room', proof)).toThrow()
  expect(() => authority.authenticate('victim', 'room', guest.proof(authority.challenge().nonce, 'room'))).toThrow()
  expect(() => authority.authenticate(guest.playerId, 'other', guest.proof(authority.challenge().nonce, 'room'))).toThrow()
  const corrupt = guest.proof(authority.challenge().nonce, 'room'); corrupt.signature = '0'.repeat(128)
  expect(() => authority.authenticate(guest.playerId, 'room', corrupt)).toThrow()
  vi.useFakeTimers()
  try {
    const stale = guest.proof(authority.challenge().nonce, 'room')
    vi.advanceTimersByTime(30001)
    expect(() => authority.authenticate(guest.playerId, 'room', stale)).toThrow()
  } finally { vi.useRealTimers() }
})
