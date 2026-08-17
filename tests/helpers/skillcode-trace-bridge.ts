export type SkillCodeTraceEvidence = {
  fixture: string
  surface: string
  seed: number
  command: Record<string, unknown>
  trace: unknown[]
  actionLog: unknown[]
  outcome: Record<string, unknown>
  stateHash: string
}

export type SkillCodeSeedRuntime = {
  mulberry32: (seed: number) => () => number
  setRng: (next: () => number) => void
}

type CaptureEvidenceInput = {
  fixture: string
  surface: string
  seed: number
  command: Record<string, unknown>
  trace: unknown[]
  state: { actions?: unknown[] }
  outcome: Record<string, unknown>
  stateHash: string
}

type Difference = {
  path: string
  node: unknown
  browser: unknown
}

const EVIDENCE_FIELDS: Array<keyof SkillCodeTraceEvidence> = [
  'fixture',
  'surface',
  'seed',
  'command',
  'trace',
  'actionLog',
  'outcome',
  'stateHash',
]

export function seedSkillCodeRuntime(runtime: SkillCodeSeedRuntime, seed: number): void {
  runtime.setRng(runtime.mulberry32(seed >>> 0))
}

export function captureSkillCodeTraceEvidence(input: CaptureEvidenceInput): SkillCodeTraceEvidence {
  return cloneJson({
    fixture: input.fixture,
    surface: input.surface,
    seed: input.seed >>> 0,
    command: input.command,
    trace: input.trace,
    actionLog: input.state.actions ?? [],
    outcome: input.outcome,
    stateHash: input.stateHash,
  }) as SkillCodeTraceEvidence
}

export function formatSkillCodeTraceEvidence(evidence: SkillCodeTraceEvidence): string {
  return stableStringify(evidence)
}

export function assertSkillCodeTraceParity(
  node: SkillCodeTraceEvidence,
  browser: SkillCodeTraceEvidence,
): void {
  for (const field of EVIDENCE_FIELDS) {
    const difference = firstDifference(node[field], browser[field], field)
    if (difference) throw new Error(formatMismatch(node, difference))
  }
}

function formatMismatch(evidence: SkillCodeTraceEvidence, difference: Difference): string {
  const seedHex = `0x${evidence.seed.toString(16).padStart(8, '0')}`
  return [
    '[RED-75] Node/browser skillCode differential mismatch',
    `fixture: ${evidence.fixture}`,
    `surface: ${evidence.surface}`,
    `seed: ${seedHex} (${evidence.seed})`,
    `command: ${stableStringify(evidence.command)}`,
    `first difference: ${difference.path}`,
    `node: ${stableStringify(difference.node)}`,
    `browser: ${stableStringify(difference.browser)}`,
    'reproduce:',
    '  npm.cmd run build:game-engine',
    `  npx.cmd --no-install vitest run tests/game/skillcode-browser-differential.test.ts -t ${JSON.stringify(evidence.fixture)}`,
  ].join('\n')
}

function firstDifference(node: unknown, browser: unknown, path: string): Difference | undefined {
  if (Object.is(node, browser)) return undefined

  if (Array.isArray(node) || Array.isArray(browser)) {
    if (!Array.isArray(node) || !Array.isArray(browser)) return { path, node, browser }
    if (node.length !== browser.length) {
      return { path: `${path}.length`, node: node.length, browser: browser.length }
    }
    for (let index = 0; index < node.length; index += 1) {
      const difference = firstDifference(node[index], browser[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return undefined
  }

  if (isRecord(node) || isRecord(browser)) {
    if (!isRecord(node) || !isRecord(browser)) return { path, node, browser }
    const keys = [...new Set([...Object.keys(node), ...Object.keys(browser)])].sort()
    for (const key of keys) {
      if (!(key in node) || !(key in browser)) {
        return {
          path: `${path}.${key}`,
          node: key in node ? node[key] : '<missing>',
          browser: key in browser ? browser[key] : '<missing>',
        }
      }
      const difference = firstDifference(node[key], browser[key], `${path}.${key}`)
      if (difference) return difference
    }
    return undefined
  }

  return { path, node, browser }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(sortForStableJson(value))
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortForStableJson(value[key])]),
  )
}
