import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { AUTHOR_MODULE_CATEGORIES, RETIRED_AUTHOR_MODULES } from '../../lib/skill-graph/author-module-catalog'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { getRuleDate, RuleRuntime, withRuleRuntime } from '../../lib/game/rule-runtime'
import { GAMEPLAY_MODULE_REGISTRY, getGameplayModuleCatalog, getGameplayModule } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'

describe('author-facing module vocabulary', () => {
  it('categorizes every callable interface while retaining legacy adapters only for internal loading', () => {
    const catalog = getGameplayModuleCatalog()
    for (const entry of catalog) {
      expect(Object.keys(AUTHOR_MODULE_CATEGORIES)).toContain(entry.ui?.category)
      expect(['standard', 'compatibility']).toContain(entry.ui?.authoring)
    }
    for (const id of ['recall.store-record', 'marker.trigger-target', 'choice.option-pair', 'choice.is-unresolved', 'query.piece']) {
      expect(catalog.find(entry => entry.id === id)?.ui?.authoring).toBe('compatibility')
      expect(getGameplayModule(id)).toBeDefined()
    }
  })

  it('keeps reusable gameplay operations discoverable without publishing defense and protocol plumbing', () => {
    const standard = getGameplayModuleCatalog().filter(entry => entry.ui?.authoring === 'standard')
    for (const id of ['piece.field', 'compare.values', 'math.multiply', 'query.pieces', 'status.apply-record', 'rule.apply-player', 'author.effect.heal', 'author.effect.summon', 'lifecycle.remove-enemy', 'piece.detach-active', 'effect.displace-one', 'effect.displace-policy', 'effect.swap-pieces']) {
      expect(standard.some(entry => entry.id === id)).toBe(true)
    }
    expect(standard.some(entry => /^(recall\.|marker\.)/.test(entry.id))).toBe(false)
    expect(standard.some(entry => entry.id.includes('fallback'))).toBe(false)
    expect(standard.filter(entry => RETIRED_AUTHOR_MODULES.has(entry.id))).toEqual([])
  })

  it('offers unified healing and summoning while preserving old resource interfaces', () => {
    const catalog = getGameplayModuleCatalog()
    for (const id of ['effect.heal', 'effect.heal-many', 'lifecycle.queue-summon']) {
      expect(catalog.find(entry => entry.id === id)?.ui?.authoring).toBe('compatibility')
      expect(getGameplayModule(id)).toBeDefined()
      expect(RETIRED_AUTHOR_MODULES.has(id)).toBe(false)
    }
    expect(catalog.find(entry => entry.id === 'author.effect.heal' && entry.version === '2')?.ui?.authoring).toBe('standard')
    expect(catalog.find(entry => entry.id === 'author.effect.summon')?.ui?.authoring).toBe('standard')
  })

  it('publishes the deterministic execution clock as a read-only author source', () => {
    const catalog = getGameplayModuleCatalog()
    const entry = catalog.find(item => item.id === 'identity.host-time' && item.version === '1')
    expect(entry).toMatchObject({
      label: '本次执行时间',
      outputs: [{ name: 'value', type: 'number' }],
      ui: { authoring: 'standard' },
    })
    expect(entry?.description).toContain('确定性宿主时钟')
    const descriptor = getGameplayModule('identity.host-time')!
    expect(descriptor.lower({
      surface: 'skill', callId: 'host-time-test', moduleId: 'identity.host-time', moduleVersion: '1',
      inputs: {}, parameters: {}, outputPorts: descriptor.outputs, emitLiteral: value => JSON.stringify(value),
    })).toBe('Date.now()')

    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      outputs: [{ name: 'time', type: 'number' }],
      body: [
        { kind: 'call', id: 'now', module: 'identity.host-time', version: '1', inputs: {}, parameters: {} },
        { kind: 'return', id: 'done', value: { kind: 'output', node: 'now', port: 'value' } },
      ],
    }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    const runAt = (runtime: RuleRuntime) => withRuleRuntime(runtime, () => {
      const execute = runInNewContext('(' + compiled.code + ')', { Date: getRuleDate() }) as (context: unknown) => unknown
      return execute({})
    })
    expect(runAt(new RuleRuntime({ rootSeed: 1700000000, tick: 17 }))).toBe(18_000_000)
    expect(runAt(new RuleRuntime({ rootSeed: 1700000000, tick: 17 }))).toBe(18_000_000)
  })

  it('publishes lifecycle atoms while retaining captured summon and data-owned detach adapters', () => {
    const catalog = getGameplayModuleCatalog()
    expect(catalog.find(entry => entry.id === 'lifecycle.remove-enemy' && entry.version === '1')?.ui?.authoring).toBe('standard')
    expect(catalog.find(entry => entry.id === 'piece.detach-active' && entry.version === '2')?.ui?.authoring).toBe('standard')
    expect(catalog.find(entry => entry.id === 'piece.detach-active' && entry.version === '1')?.ui?.authoring).toBe('compatibility')
    expect(catalog.find(entry => entry.id === 'lifecycle.summon-captured' && entry.version === '1')?.ui?.authoring).toBe('compatibility')
    expect(getGameplayModule('piece.detach-active', '2')?.parameters?.map(parameter => parameter.name)).toEqual(['flowStatePolicy'])
  })
})
