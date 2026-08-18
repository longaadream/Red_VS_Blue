import {
  RANDOM_STREAM_NAMES,
  getActiveRuleRuntime,
  mulberry32,
} from './rule-runtime'

// RED-28 migration adapter. Authoritative rule runners install RuleRuntime;
// legacy/non-authoritative callers keep the previous injectable local source.
let legacyRng: () => number = Math.random.bind(Math)

export function setRng(fn: () => number): void {
  legacyRng = fn
}

export function getRng(): () => number {
  return legacyRng
}

export function rng(): number {
  const runtime = getActiveRuleRuntime()
  return runtime
    ? runtime.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
    : legacyRng()
}

export { mulberry32 }
