import type { BattleState } from './turn'
import type { PieceInstance } from './piece'
import { BattleRuleError } from './battle-types'

type Coordinates = { x: PieceInstance['x']; y: PieceInstance['y'] }
type Guard = { depth: number; violation: boolean; restores: Array<() => void> }
const authorized = new WeakMap<PieceInstance, Coordinates>()
const protectedPieces = new WeakSet<PieceInstance>()
const activeGuards = new WeakMap<BattleState, Guard>()
let currentGuard: Guard | undefined
let writerDepth = 0

function fail(guard: Guard): never {
  guard.violation = true
  throw new BattleRuleError('Use the position API to change board coordinates', 'POSITION_WRITE_FORBIDDEN')
}

function protect(piece: PieceInstance, guard: Guard): void {
  if (protectedPieces.has(piece)) return
  protectedPieces.add(piece)
  for (const key of ['x', 'y'] as const) {
    let value = piece[key]
    const get = () => value
    const set = (next: typeof value) => { if (!writerDepth) fail(guard); value = next }
    Object.defineProperty(piece, key, { configurable: true, enumerable: true, get, set })
    guard.restores.push(() => {
      const descriptor = Object.getOwnPropertyDescriptor(piece, key)
      if (descriptor?.get !== get || descriptor.set !== set) guard.violation = true
      Object.defineProperty(piece, key, { configurable: true, enumerable: true, writable: true, value })
    })
  }
  guard.restores.push(() => { protectedPieces.delete(piece) })
}

export function assertAuthorizedPositions(battle: BattleState): void {
  const guard = activeGuards.get(battle)
  if (!guard) return
  for (const piece of battle.pieces) {
    const expected = authorized.get(piece)
    if (!expected || expected.x !== piece.x || expected.y !== piece.y) fail(guard)
  }
}

/** Engine-private authority used by relocation and existing placement lifecycles. */
export function writePiecePosition(piece: PieceInstance, x: PieceInstance['x'], y: PieceInstance['y']): void {
  // New summons stay protected after any nested rule returns.
  if (currentGuard) protect(piece, currentGuard)
  writerDepth++
  try { piece.x = x; piece.y = y; authorized.set(piece, { x, y }) }
  finally { writerDepth-- }
}

/** Trusted content can mutate effects; coordinates must use the engine authority. */
export function withPositionWriteGuard<T>(battle: BattleState, execute: () => T): T {
  assertAuthorizedPositions(battle)
  const guard = activeGuards.get(battle) ?? { depth: 0, violation: false, restores: [] }
  const previousGuard = currentGuard
  currentGuard = guard
  activeGuards.set(battle, guard)
  guard.depth++
  try {
    for (const piece of battle.pieces) {
      if (!protectedPieces.has(piece)) {
        authorized.set(piece, { x: piece.x, y: piece.y })
        protect(piece, guard)
      }
    }
    return execute()
  } finally {
    try { assertAuthorizedPositions(battle) }
    finally {
      currentGuard = previousGuard
      guard.depth--
      if (!guard.depth) {
        activeGuards.delete(battle)
        try { for (const restore of guard.restores) restore() }
        finally { guard.restores.length = 0 }
      }
    }
    if (guard.violation) fail(guard)
  }
}
