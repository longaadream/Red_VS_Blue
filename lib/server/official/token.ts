import { timingSafeEqual } from 'node:crypto'

export function equalToken(provided: string, expected: string): boolean {
  const left = Buffer.from(provided), right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
