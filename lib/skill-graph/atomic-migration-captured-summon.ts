import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayValue } from './module-types'

/**
 * The old captured-summon adapter remains loadable for existing resources.
 * New author graphs use the same summon sentence with declaration mode so the
 * declaration capability and the authenticated execution source stay visible
 * to the normal compiler.
 */
export const ATOMIC_CAPTURED_SUMMON_MODULES = new Set(['lifecycle.summon-captured'])

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const isValue = (value: unknown): value is GameplayValue => Boolean(
  value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { kind?: unknown }).kind === 'string',
)

function migrateCapturedSummon(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = node.inputs?.source
  const cell = node.inputs?.cell
  if (node.version !== '1' || !isValue(source) || !isValue(cell)) return undefined

  const queueCount = fresh('queue-count')
  return {
    statements: [
      {
        ...node,
        module: 'author.effect.summon',
        version: '2',
        inputs: { source, destination: cell },
        parameters: {
          mode: 'declaration',
          sourceType: 'record',
          destinationType: 'cell',
        },
      },
      {
        kind: 'call',
        id: queueCount,
        module: 'result.field',
        version: '1',
        inputs: { record: output(node.id, 'result') },
        parameters: { field: 'queueCount' },
      },
    ],
    outputs: { queued: output(queueCount, 'value') },
  }
}

/**
 * Lower only the well-formed old adapter shape.  Malformed or unusual graphs
 * stay untouched so migration can report them instead of changing behavior.
 */
export const atomicCapturedSummonRecipe: AtomicRecipe = (node, fresh) => (
  node.module === 'lifecycle.summon-captured' ? migrateCapturedSummon(node, fresh) : undefined
)
