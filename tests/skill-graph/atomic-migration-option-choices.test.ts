import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ATOMIC_OPTION_CHOICE_MODULES, migrateOptionChoices } from '../../lib/skill-graph/atomic-migration-option-choices'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph, type GameplayJsonValue } from '../../lib/skill-graph/module-types'

const parameters: Record<string, Record<string, GameplayJsonValue>> = {
  'choice.string-options': { options: ['a', 'b', 'c'], labels: ['甲'] },
  'choice.multi-string': { options: ['a', 'b', 'c'], minSelections: 2, maxSelections: 3 },
  'choice.binary-option': { title: '触发吗', yesLabel: '触发', noLabel: '不触发' },
  'choice.required-option-pair': { firstLabel: '甲', firstValue: 'a', secondLabel: '乙', secondValue: 'b' },
  'choice.option-pair-cancel': { title: '选择', firstLabel: '甲', firstValue: 'a', secondLabel: '乙', secondValue: 'b', firstDescription: '说明甲', secondDescription: '说明乙', cancelValue: 'b' },
}

function graph(module: string): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
    { kind: 'call', id: 'choice', module, version: '1', parameters: parameters[module],
      ...(module === 'choice.required-option-pair' ? { inputs: { title: { kind: 'literal', value: '选择' } } } : {}) },
    { kind: 'return', id: 'return', values: { result: { kind: 'output', node: 'choice', port: 'choice' } } },
  ], outputs: [{ name: 'result', type: 'choice' }] }
}
function execute(graph: GameplayModuleGraph, response: unknown, context: Record<string, unknown> = { playerId: 'red' }) {
  const requests: unknown[] = []
  const flow = { event: { read: () => ({ playerId: 'red' }) }, choice: { option: (config: unknown) => { requests.push(config); return response } } }
  const run = runInNewContext('(' + compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code + ')', { flow }) as (context: unknown) => unknown
  const result = run(context)
  return JSON.parse(JSON.stringify({ requests, result }))
}
describe('generic option choice migration', () => {
  for (const moduleId of ATOMIC_OPTION_CHOICE_MODULES) {
    it('preserves ' + moduleId + ' options, optional fields, selected and pending results', () => {
      const source = graph(moduleId), migrated = migrateOptionChoices(source)
      expect(migrateOptionChoices(migrated)).toEqual(migrated)
      expect(JSON.stringify(migrated)).not.toContain('"module":"' + moduleId + '"')
      for (const response of ['a', ['a', 'b'], { needsOptionSelection: true }, null]) {
        expect(execute(migrated, response)).toEqual(execute(source, response))
      }
    })
  }

  it('keeps an omitted binary or required player usable with context fallback', () => {
    for (const moduleId of ['choice.binary-option', 'choice.required-option-pair']) {
      const migrated = migrateOptionChoices(graph(moduleId))
      const result = execute(migrated, { needsOptionSelection: true }, {})
      expect(result.result).toEqual({ result: { needsOptionSelection: true } })
      const config = result.requests[0] as { playerId?: unknown }
      expect(config.playerId).toBeNull()
    }
  })
})
