import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { authorModuleUi } from '../../lib/skill-graph/author-module-catalog'
import { ATOMIC_FIELD_ALIASES } from '../../lib/skill-graph/atomic-migration-fields'
import { ATOMIC_PREDICATE_MODULES } from '../../lib/skill-graph/atomic-migration-predicates'
import { ATOMIC_VALUE_MODULES } from '../../lib/skill-graph/module-registry-generic-values'
import { getGameplayModule, GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { migrateAtomicAuthorGraph } from '../../scripts/migrate-atomic-author-modules'
import type { GameplayCallStatement, GameplayIfStatement, GameplayStatement } from '../../lib/skill-graph/module-types'
import {
  ATOMIC_AUTHOR_SAMPLE_ENTRIES,
  buildAtomicAuthorSampleGraph,
} from '../../scripts/migrate-atomic-author-samples'

type Call = GameplayCallStatement

function collectCalls(statements: readonly GameplayStatement[], calls: Call[] = []): Call[] {
  for (const statement of statements) {
    if (statement.kind === 'call') calls.push(statement)
    if (statement.kind === 'if') {
      collectCalls(statement.then, calls)
      collectCalls(statement.else ?? [], calls)
    }
    if (statement.kind === 'foreach' || statement.kind === 'collection' || statement.kind === 'while') {
      collectCalls(statement.body, calls)
    }
  }
  return calls
}

function collectIfs(statements: readonly GameplayStatement[], branches: GameplayIfStatement[] = []): GameplayIfStatement[] {
  for (const statement of statements) {
    if (statement.kind === 'if') {
      branches.push(statement)
      collectIfs(statement.then, branches)
      collectIfs(statement.else ?? [], branches)
    }
    if (statement.kind === 'foreach' || statement.kind === 'collection' || statement.kind === 'while') {
      collectIfs(statement.body, branches)
    }
  }
  return branches
}

function graphCalls(id: (typeof ATOMIC_AUTHOR_SAMPLE_ENTRIES)[number]['id']): Call[] {
  return collectCalls(buildAtomicAuthorSampleGraph(id).body)
}

function modules(id: (typeof ATOMIC_AUTHOR_SAMPLE_ENTRIES)[number]['id']): string[] {
  return graphCalls(id).map(statement => statement.module)
}

describe('RED-252 atomic author samples', () => {
  it('returns converged canonical graphs from every public sample entry', () => {
    for (const entry of ATOMIC_AUTHOR_SAMPLE_ENTRIES) {
      const graph = entry.build()
      expect(migrateAtomicAuthorGraph(graph), entry.id).toEqual(graph)
      expect(buildAtomicAuthorSampleGraph(entry.id), entry.id).toEqual(graph)
    }
  })

  it('compiles every migrated graph and exposes only standard authoring modules', () => {
    for (const entry of ATOMIC_AUTHOR_SAMPLE_ENTRIES) {
      const graph = entry.build()
      expect(() => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY), entry.id).not.toThrow()
      for (const statement of collectCalls(graph.body)) {
        const descriptor = getGameplayModule(statement.module, statement.version)
        expect(descriptor, `${entry.id}: missing ${statement.module}`).toBeDefined()
        if (descriptor) expect(authorModuleUi(descriptor).authoring, `${entry.id}: ${statement.module}`).toBe('standard')
      }
    }
  })

  it('does not regress to specialized fallback wrappers', () => {
    const forbidden = [
      /^recall\./,
      /^marker\./,
      /^value\.present/,
      /^query\.(piece|has-piece)$/,
      /^piece\.alive$/,
      /^query\.same-relation$/,
      /^compare\.allied-players$/,
      /^status\.mark-(apply|remove)$/,
      /^status\.has-source-mark$/,
      /^choice\.option-pair$/,
      /^effect\.teleport$/,
    ]
    for (const entry of ATOMIC_AUTHOR_SAMPLE_ENTRIES) {
      for (const moduleId of modules(entry.id)) {
        const retired = ATOMIC_FIELD_ALIASES.has(moduleId)
          || ATOMIC_PREDICATE_MODULES.has(moduleId)
          || ATOMIC_VALUE_MODULES.has(moduleId)
        expect(retired || forbidden.some(pattern => pattern.test(moduleId)), `${entry.id}: ${moduleId}`).toBe(false)
      }
    }
  })

  it('keeps the four sample contracts expressed by atomic calls', () => {
    const fireball = graphCalls('skills/fireball')
    expect(fireball.find(call => call.module === 'author.choice.target-piece')?.parameters).toMatchObject({ range: 5, filter: 'enemy' })
    expect(fireball.find(call => call.module === 'author.effect.damage')?.parameters).toMatchObject({ damageType: 'normal' })

    const naruto = modules('skills/naruto-shadow-clone')
    expect(naruto).toContain('author.choice.option')
    expect(naruto).toContain('author.choice.target-cell')
    expect(naruto).toContain('effect.displace-one')
    expect(naruto).toContain('lifecycle.queue-summon')

    const recall = modules('skills/recall')
    expect(recall).toEqual(expect.arrayContaining([
      'author.choice.option', 'instance.copy-piece', 'extension.map-declare', 'extension.map-put',
    ]))
    const recallGraph = buildAtomicAuthorSampleGraph('skills/recall')
    const recallFields = recallGraph.schemas?.find(schema => schema.id === 'atomic-recall-record@1')?.fields ?? []
    expect(recallFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'piece', type: 'piece', nullable: true }),
      expect.objectContaining({ name: 'pieceKey', type: 'string' }),
    ]))
    expect(recallFields.find(field => field.name === 'pieceKey')).not.toHaveProperty('nullable')
    expect(recallFields.find(field => field.name === 'pieceKey')).not.toHaveProperty('optional')
    expect(graphCalls('skills/recall').filter(call => call.module === 'extension.map-declare' || call.module === 'extension.map-put')
      .every(call => call.parameters?.keyField === 'pieceKey')).toBe(true)
    expect(recall).not.toContain('result.action')
    expect(recallGraph.outputs).toEqual([])
    expect(modules('skills/recall-endturn-trigger')).toEqual(expect.arrayContaining(['extension.map-items', 'extension.map-remove', 'instance.apply-piece']))

    const minato = modules('rules/rule-minato-flying-raijin-trigger')
    expect(minato).toEqual(expect.arrayContaining([
      'ref.target', 'ref.source', 'context.field', 'piece.field', 'compare.values',
      'spatial.adjacent-cells-ordered', 'spatial.cell-landing-legal', 'collection.random',
      'effect.displace-one', 'author.effect.damage', 'status.query-instances',
      'status.fields', 'data.optional-field', 'status.set-number-instance', 'status.make-id', 'status.apply-record', 'status.remove-instance',
      'collection.at',
    ]))
    expect(minato).not.toContain('event.reserved-cells')
    expect(minato).not.toContain('query.random-cell')
    const factionReads = graphCalls('rules/rule-minato-flying-raijin-trigger').filter(call => call.module === 'piece.field' && call.parameters?.field === 'faction')
    expect(factionReads).toHaveLength(3)
    expect(factionReads.every(call => call.version === '2')).toBe(true)
    const factionComparisons = graphCalls('rules/rule-minato-flying-raijin-trigger').filter(call =>
      call.module === 'compare.values' && call.parameters?.valueType === 'string'
      && ['marked-ally', 'source-enemy', 'marked-enemy'].includes(call.id))
    expect(factionComparisons).toHaveLength(3)
    expect(factionComparisons.map(call => call.parameters?.operator)).toEqual(expect.arrayContaining(['==', '!=']))
    for (const id of ['recall-move-trigger', 'recall-endturn-trigger', 'recall-skill-trigger'] as const) {
      expect(modules(`skills/${id}`)).toEqual(expect.arrayContaining(['player.field', 'compare.values']))
      expect(modules(`skills/${id}`)).not.toContain('attribute.player-text')
      expect(modules(`skills/${id}`)).not.toContain('compare.not-equal-string')
      const factionFields = graphCalls(`skills/${id}`).filter(call =>
        call.module === 'player.field' && call.parameters?.field === 'faction')
      expect(factionFields).toHaveLength(2)
      const enemyComparison = graphCalls(`skills/${id}`).find(call => call.id === 'enemy-action')
      expect(enemyComparison).toMatchObject({
        module: 'compare.values',
        parameters: { valueType: 'string', operator: '!=' },
      })
    }

    const minatoGraph = buildAtomicAuthorSampleGraph('rules/rule-minato-flying-raijin-trigger')
    const minatoOptions = minatoGraph.schemas?.find(schema => schema.id === 'atomic-minato-flying-raijin-options@1')
    expect(minatoOptions?.fields).toEqual([
      { name: '触发飞雷神', type: 'string' },
      { name: '不触发', type: 'string' },
    ])
    const minatoChoices = graphCalls('rules/rule-minato-flying-raijin-trigger')
      .filter(call => call.module === 'author.choice.option')
    expect(minatoChoices).toHaveLength(2)
    expect(minatoChoices.every(call => call.parameters?.valueType === 'string')).toBe(true)
    const minatoChoiceComparisons = graphCalls('rules/rule-minato-flying-raijin-trigger')
      .filter(call => call.module === 'compare.values' && call.id.endsWith('-choice-confirmed'))
    expect(minatoChoiceComparisons).toHaveLength(2)
    expect(minatoChoiceComparisons.every(call =>
      call.inputs?.right?.kind === 'literal' && call.inputs.right.value === 'yes')).toBe(true)
    const choiceBranches = collectIfs(minatoGraph.body).filter(statement => statement.id.endsWith('-choice-branch'))
    expect(choiceBranches).toHaveLength(2)
    for (const branch of choiceBranches) {
      expect(collectCalls(branch.then).some(call => call.module === 'collection.random')).toBe(true)
    }
    expect(minatoGraph.body.filter(statement => statement.kind === 'call' && statement.module === 'collection.random')).toHaveLength(0)
    expect(collectCalls(minatoGraph.body).some(call => call.module === 'event.reserved-cells')).toBe(false)
    expect(collectCalls(minatoGraph.body).some(call => call.module === 'query.random-cell')).toBe(false)
    expect(graphCalls('rules/rule-minato-flying-raijin-trigger').some(call =>
      call.module === 'status.set-number-instance' && call.parameters?.field === 'currentDuration')).toBe(true)
    expect(graphCalls('rules/rule-minato-flying-raijin-trigger').some(call =>
      call.module === 'data.optional-field' && call.parameters?.field === 'stacks')).toBe(true)
    expect(graphCalls('rules/rule-minato-flying-raijin-trigger').some(call =>
      call.module === 'collection.at' && call.inputs?.position?.kind === 'literal' && call.inputs.position.value === 1)).toBe(true)
    const defensiveAliveIds = ['minato-alive', 'marked-alive', 'participants-alive', 'source-alive', 'source-eligible']
    expect(collectCalls(minatoGraph.body).some(call => defensiveAliveIds.includes(call.id))).toBe(false)
    expect(graphCalls('rules/rule-minato-flying-raijin-trigger').some(call => call.module === 'piece.alive')).toBe(false)
    const eligible = graphCalls('rules/rule-minato-flying-raijin-trigger').find(call => call.id === 'eligible')
    expect(eligible?.inputs).toEqual({
      left: { kind: 'output', node: 'not-spiral', port: 'value' },
      right: { kind: 'output', node: 'has-mark', port: 'value' },
    })
    expect(collectIfs(minatoGraph.body).find(statement => statement.id === 'eligible-branch')?.condition).toEqual({
      kind: 'output', node: 'eligible', port: 'value',
    })
    const markedAllyBranch = choiceBranches.length > 0
      ? collectIfs(minatoGraph.body).find(statement => statement.id === 'marked-ally-branch')
      : undefined
    expect(markedAllyBranch?.then.some(statement => statement.kind === 'call' && statement.id === 'source-alive')).toBe(false)
    expect(collectIfs(minatoGraph.body).find(statement => statement.id === 'source-enemy-branch')?.condition).toEqual({
      kind: 'output', node: 'source-enemy', port: 'value',
    })
  })
})
