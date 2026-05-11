let _rng: () => number = Math.random.bind(Math)

export function setRng(fn: () => number): void {
  _rng = fn
}

export function rng(): number {
  return _rng()
}

/** Mulberry32 — fast 32-bit seeded PRNG, no dependencies */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return (): number => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
