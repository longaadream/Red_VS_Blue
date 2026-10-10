import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildContentGraphWithPending,
  buildPendingSubgraph,
  extractPendingSubgraphs,
  replacePendingGraphExpressions,
} from '../../electron-editor/content-graph-pending'
import { importContentGraph, } from '../../electron-editor/content-graph-import'
import { compileContentGraph } from '../../electron-editor/content-graph'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as {
  entries: Record<string, Record<string, unknown>>
}

function runPending(source: string, context: unknown, randomValues: number[]): { result: unknown; randomCalls: number } {
  let randomCalls = 0
  const math = {
    floor: Math.floor,
    random: () => {
      randomCalls += 1
      return randomValues[randomCalls - 1] ?? 0
    },
  }
  const execute = new Function('Math', `return (${source})`)(math) as (value: unknown) => unknown
  return { result: execute(context), randomCalls }
}

function hasSourceExpression(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSourceExpression)
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.kind === 'source' || Object.values(record).some(hasSourceExpression)
}

function sourceExpressionCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + sourceExpressionCount(item), 0)
  if (!value || typeof value !== 'object') return 0
  const record = value as Record<string, unknown>
  return (record.kind === 'source' ? 1 : 0)
    + Object.values(record).reduce<number>((count, child) => count + sourceExpressionCount(child), 0)
}

describe('typed pending content graph extraction', () => {
  it('imports Minato effectCode as an independent typed graph', () => {
    const source = String(frozen.entries['skills/minato-spiral-barrage'].code)
    const extraction = extractPendingSubgraphs(source, 'minato-spiral-barrage.js')

    expect(extraction.candidates).toHaveLength(1)
    expect(extraction.candidates[0]).toMatchObject({
      sourceKind: 'effectCode-string',
      parameterAliases: ['ctx'],
      path: expect.stringContaining('.pendingTargetSelection.effectCode'),
    })
    expect(extraction.builds).toHaveLength(1)
    expect(extraction.failures).toHaveLength(0)
    expect(extraction.builds[0].graph.surface).toBe('pending')
    expect(extraction.builds[0].graph.metadata).toMatchObject({
      pendingParameterAliases: ['ctx'],
      pendingSourceKind: 'effectCode-string',
    })
    expect(hasSourceExpression(extraction.builds[0].graph)).toBe(false)
    expect(JSON.stringify(extraction.builds[0].graph)).not.toContain(extraction.candidates[0].source)
  })

  it('resolves local .toString functions and preserves the original parameter alias', () => {
    const source = String(frozen.entries['skills/turalyon-grand-crusade'].code)
    const extraction = extractPendingSubgraphs(source, 'turalyon-grand-crusade.js')
    const byName = new Map(extraction.candidates.map(candidate => [candidate.functionName, candidate]))

    expect([...byName.keys()]).toEqual(['completeGathering', 'chooseGathering'])
    expect(byName.get('completeGathering')).toMatchObject({
      sourceKind: 'local-function-toString',
      parameterAliases: ['finalCtx'],
    })
    expect(byName.get('completeGathering')?.source).toContain('圣光大远征的棋子选择已失效')
    expect(byName.get('chooseGathering')?.source).toContain('圣光大远征：选择集结点')

    // Every candidate is either a typed graph or an explicit importer gap;
    // no candidate is silently dropped and no failure creates a source node.
    expect(extraction.builds.length + extraction.failures.length).toBe(2)
    expect(extraction.builds.every(build => !JSON.stringify(build.graph).includes('"code"'))).toBe(true)
    expect(extraction.builds.find(build => build.candidate.functionName === 'completeGathering')?.graph.metadata)
      .toMatchObject({ pendingParameterAliases: ['finalCtx'] })
    expect(extraction.failures.every(failure => failure.error.length > 0)).toBe(true)
  })

  it('rejects variable and conditionally initialized function bindings before graph import', () => {
    const sources = [
      `function executeSkill(context) {
        var result = { pendingTargetSelection: { effectCode: f.toString() } };
        const f = function(ctx) { return { success: true, value: ctx.value }; };
        return result;
      }`,
      `function executeSkill(context) {
        var result = { pendingTargetSelection: { effectCode: f.toString() } };
        var f = function(ctx) { return { success: true, value: ctx.value }; };
        return result;
      }`,
      `function executeSkill(context) {
        var result = { pendingTargetSelection: { effectCode: f.toString() } };
        if (context.enabled) {
          function f(ctx) { return { success: true, value: ctx.value }; }
        }
        return result;
      }`,
    ]

    for (const source of sources) {
      const extraction = extractPendingSubgraphs(source)
      expect(extraction.candidates).toHaveLength(1)
      expect(extraction.builds).toHaveLength(0)
      expect(extraction.failures).toHaveLength(1)
      expect(extraction.failures[0].error).toMatch(/effectCode 必须是字符串或同一词法作用域内的本地函数\.toString\(\)/)
    }

    const hoistedDeclaration = extractPendingSubgraphs(`function executeSkill(context) {
      var result = { pendingTargetSelection: { effectCode: f.toString() } };
      function f(ctx) { return { success: true, value: ctx.value }; }
      return result;
    }`)
    expect(hoistedDeclaration.failures).toHaveLength(0)
    expect(hoistedDeclaration.builds).toHaveLength(1)
  })

  it('builds Minato and Turalyon parent graphs after recursively extracting pending sources', () => {
    const minatoSource = String(frozen.entries['skills/minato-spiral-barrage'].code)
    const minato = buildContentGraphWithPending(minatoSource, 'skill', 'minato-spiral-barrage.js')

    expect(minato.pending.failures).toHaveLength(0)
    expect(minato.sourcePairs).toHaveLength(1)
    expect(minato.sourcePairs[0].candidate.sourceKind).toBe('effectCode-string')
    expect(minato.sourcePairs[0].legacy).toBe(minato.sourcePairs[0].candidate.source)
    expect(sourceExpressionCount(minato.graph)).toBe(1)
    expect(minato.transformedSource).not.toContain(minato.sourcePairs[0].legacy)
    expect(compileContentGraph(minato.graph).code).not.toContain('.toString()')

    const turalyonSource = String(frozen.entries['skills/turalyon-grand-crusade'].code)
    const turalyon = buildContentGraphWithPending(turalyonSource, 'skill', 'turalyon-grand-crusade.js')

    expect(turalyon.pending.failures).toHaveLength(0)
    expect(turalyon.sourcePairs.map(pair => pair.candidate.functionName)).toEqual([
      'chooseGathering',
      'completeGathering',
    ])
    expect(turalyon.sourcePairs.every(pair => pair.legacy.length > 0 && pair.compiled.includes('function(ctx)'))).toBe(true)
    expect(sourceExpressionCount(turalyon.graph)).toBe(2)
    expect(turalyon.transformedSource).not.toMatch(/function\s+chooseGathering/)
    expect(turalyon.transformedSource).not.toMatch(/completeGathering\.toString\(\)/)
    expect(compileContentGraph(turalyon.graph).code).not.toContain('.toString()')
  })

  it('rejects a pending function that captures an outer lexical variable', () => {
    const source = `function executeSkill(context) {
      var captured = 7;
      return { pendingTargetSelection: { effectCode: function(finalCtx) { return captured + finalCtx.value; }.toString() } };
    }`
    const extraction = extractPendingSubgraphs(source)

    expect(extraction.builds).toHaveLength(0)
    expect(extraction.failures).toHaveLength(1)
    expect(extraction.failures[0].error).toMatch(/捕获外层变量.*captured/)

    const freeCanonicalRoot = `function executeSkill(context) {
      return { pendingTargetSelection: { effectCode: function(finalCtx) { return ctx.value + finalCtx.value; }.toString() } };
    }`
    const rootCapture = extractPendingSubgraphs(freeCanonicalRoot)
    expect(rootCapture.failures[0].error).toMatch(/捕获外层变量.*ctx/)
  })

  it('preserves result, failure payload, RNG count and alias while compiling a pending graph', () => {
    const pendingSource = `function(finalCtx) {
      if (!finalCtx.payload) return { success: false, message: '缺少payload', payload: finalCtx.payload };
      return { success: true, payload: finalCtx.payload, roll: Math.floor(Math.random() * 10), message: '保留标识' };
    }`
    const build = buildPendingSubgraph(pendingSource)
    const generatedSource = compileContentGraph(build.graph).code
    expect(build.normalizedSource).toContain('function(ctx)')
    expect(build.graph.metadata).toMatchObject({ pendingParameterAliases: ['finalCtx'] })
    expect(hasSourceExpression(build.graph)).toBe(false)

    for (const context of [{ payload: { id: 'payload-1' } }, {}]) {
      const original = runPending(pendingSource, context, [0.42])
      const generated = runPending(generatedSource, context, [0.42])
      expect(generated).toEqual(original)
    }
  })

  it('replaces one literal parent expression with the independent pending graph', () => {
    const pendingSource = `function(finalCtx) { return { success: true, payload: finalCtx.payload, message: '保留标识' }; }`
    const build = buildPendingSubgraph(pendingSource)
    const parentSource = `function executeSkill(context) { return { pendingTargetSelection: { effectCode: ${JSON.stringify(pendingSource)} } }; }`
    const parentGraph = importContentGraph(parentSource, 'skill')
    const replaced = replacePendingGraphExpressions(parentGraph, [build])

    expect(hasSourceExpression(replaced)).toBe(true)
    expect(JSON.stringify(replaced)).not.toContain(pendingSource)
    const generatedParent = compileContentGraph(replaced).code
    const executeParent = new Function(`${generatedParent}; return executeSkill;`)() as (context: unknown) => unknown
    expect(executeParent({})).toMatchObject({ pendingTargetSelection: { effectCode: expect.stringContaining('function(ctx)') } })
  })
})
