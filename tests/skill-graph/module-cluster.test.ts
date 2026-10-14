import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph, type GameplayModuleGraph } from '../../lib/skill-graph/module-document'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  SKILL_CLUSTER_DEFINITION_VERSION,
  assertSkillClusterMetadata,
  buildSkillCluster,
  buildSkillClusterCatalog,
  validateSkillClusterDefinition,
  type SkillClusterCatalogInput,
} from '../../lib/skill-graph/module-cluster'

type JsonRecord = Record<string, unknown>

function load(relative: string): JsonRecord {
  return JSON.parse(readFileSync(resolve(process.cwd(), relative), 'utf8')) as JsonRecord
}

function catalog(files: { skills?: string[]; rules?: string[]; pieces?: string[]; cards?: string[] }): SkillClusterCatalogInput {
  const table = (paths: string[] | undefined): Record<string, JsonRecord> => Object.fromEntries((paths ?? []).map(path => {
    const value = load(path)
    return [value.id, value]
  }))
  return {
    skills: table(files.skills),
    rules: table(files.rules),
    pieces: table(files.pieces),
    ...(files.cards ? { cards: table(files.cards) } : {}),
  }
}

describe('skill Cluster authoring view', () => {
  it('aggregates the active shadow-clone skill and keeps inline summon status/rules as references', () => {
    const input = catalog({
      skills: ['data/skills/naruto-shadow-clone.json'],
      rules: [
        'data/rules/rule-naruto-clone-died.json',
        'data/rules/rule-naruto-clone-immobile.json',
        'data/rules/rule-naruto-clone-one-hit.json',
      ],
    })
    const result = buildSkillCluster(input, { collection: 'skills', id: 'naruto-shadow-clone' })
    expect(result.version).toBe(SKILL_CLUSTER_DEFINITION_VERSION)
    expect(result.kind).toBe('active')
    expect(result.members.skills.map(member => member.id)).toEqual(['naruto-shadow-clone'])
    expect(result.members.rules.map(member => member.id)).toEqual([
      'rule-naruto-clone-died',
      'rule-naruto-clone-immobile',
      'rule-naruto-clone-one-hit',
    ])
    expect(result.members.statuses).toHaveLength(1)
    expect(result.members.statuses[0]).toMatchObject({
      id: 'naruto-clone',
      evidence: 'inline',
      editable: true,
      execution: 'reference-only',
    })
    expect(result.members.statuses[0].provenance[0].path).toContain('summonCapability.status')
    expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })

  it('keeps passive skill roots independent until an explicit verified piece mapping is supplied', () => {
    const input = catalog({
      skills: ['data/skills/hidan-undying.json', 'data/skills/naruto-vanguard.json'],
      rules: [
        'data/rules/rule-hidan-undying.json',
        'data/rules/rule-hidan-dying-immune.json',
        'data/rules/rule-hidan-undying-tick.json',
      ],
      pieces: ['data/pieces/red-hidan.json', 'data/pieces/blue-naruto.json'],
    })
    const unlinkedInput = {
      ...input,
      skills: {
        ...input.skills,
        'hidan-undying': (() => {
          const copy = { ...input.skills['hidan-undying'] }
          delete copy.cluster
          return copy
        })(),
      },
    }
    const hidanWithoutMapping = buildSkillCluster(unlinkedInput, { collection: 'skills', id: 'hidan-undying' })
    expect(hidanWithoutMapping.kind).toBe('passive')
    expect(hidanWithoutMapping.members.rules).toHaveLength(0)
    expect(hidanWithoutMapping.diagnostics.some(item => item.code === 'missing-reference')).toBe(false)

    const hidan = buildSkillCluster(input, { collection: 'skills', id: 'hidan-undying' }, {
      mappingOverrides: [{
        skillId: 'hidan-undying',
        pieceId: 'red-hidan',
        ruleIds: ['rule-hidan-undying', 'rule-hidan-dying-immune'],
      }],
    })
    expect(hidan.members.rules.map(member => member.id)).toEqual([
      'rule-hidan-undying',
      'rule-hidan-undying-tick',
      'rule-hidan-dying-immune',
    ])
    expect(hidan.members.rules.filter(member => ['rule-hidan-undying', 'rule-hidan-dying-immune'].includes(member.id)).every(member => member.relation === 'owned')).toBe(true)
    expect(hidan.members.pieces.map(member => member.id)).toEqual(['red-hidan'])

    const naruto = buildSkillCluster(input, { collection: 'skills', id: 'naruto-vanguard' })
    expect(naruto.kind).toBe('passive')
    expect(naruto.members.rules).toHaveLength(0)
    expect(naruto.members.skills.map(member => member.id)).toEqual(['naruto-vanguard'])
  })

  it('builds independent piece-rule passive roots and preserves initial status provenance', () => {
    const input = catalog({
      pieces: ['data/pieces/red-hidan.json', 'data/pieces/sonic.json'],
      rules: [
        'data/rules/rule-hidan-undying.json',
        'data/rules/rule-hidan-dying-immune.json',
        'data/rules/rule-sonic-free-move.json',
        'data/rules/rule-momentum-gain.json',
        'data/rules/rule-momentum-consume.json',
      ],
    })
    const hidan = buildSkillCluster(input, { collection: 'pieces', id: 'red-hidan' })
    expect(hidan.kind).toBe('passive')
    expect(hidan.members.rules.map(member => member.id)).toEqual(['rule-hidan-dying-immune', 'rule-hidan-undying'])

    const sonic = buildSkillCluster(input, { collection: 'pieces', id: 'sonic' })
    expect(sonic.members.statuses.map(member => member.id)).toEqual([
      'sonic-free-normal-move',
      'sonic-momentum-core',
    ])
    expect(sonic.members.statuses.every(member => member.provenance[0].path.includes('initialStatusTags'))).toBe(true)
  })

  it('deduplicates shared rules, detects cycles, and reports dangling explicit references', () => {
    const shared = { id: 'shared', name: 'shared', contentGraph: { kind: 'call', capability: 'addRuleById', args: [{ kind: 'literal', value: 'x' }, { kind: 'literal', value: 'cycle' }] } }
    const cycle = { id: 'cycle', name: 'cycle', relatedRules: ['shared'] }
    const skill = {
      id: 'root', kind: 'active', relatedRules: ['shared', 'shared', 'missing-rule'],
      cluster: { links: [{ collection: 'rules', id: 'cycle', relation: 'shared', source: 'verified-review' }] },
    }
    const result = buildSkillCluster({
      skills: { root: skill },
      rules: { shared, cycle },
      pieces: {},
    }, { collection: 'skills', id: 'root' })
    expect(result.members.rules.map(member => member.id)).toEqual(['shared', 'cycle'])
    expect(result.members.rules.find(member => member.id === 'cycle')?.relation).toBe('shared')
    expect(result.members.rules.find(member => member.id === 'shared')?.provenance.length).toBeGreaterThan(1)
    expect(result.diagnostics.some(item => item.code === 'missing-reference' && item.reference === 'missing-rule')).toBe(true)
    expect(result.diagnostics.some(item => item.code === 'cycle')).toBe(true)
  })

  it('scopes inline status identity to its owning definition while deduplicating shared rules', () => {
    const catalog = {
      skills: {
        first: { id: 'first', kind: 'active', statusTag: { id: 'shared-status', type: 'same', amount: 1 }, relatedRules: ['rule'] },
        second: { id: 'second', kind: 'active', statusTag: { id: 'shared-status', type: 'same', amount: 2 }, relatedRules: ['rule'] },
      },
      rules: { rule: { id: 'rule' } },
      pieces: {},
    }
    const first = buildSkillCluster(catalog, { collection: 'skills', id: 'first' })
    const second = buildSkillCluster(catalog, { collection: 'skills', id: 'second' })
    expect(first.members.rules).toHaveLength(1)
    expect(second.members.rules).toHaveLength(1)
    expect(first.members.statuses).toHaveLength(1)
    expect(second.members.statuses).toHaveLength(1)
    expect(first.members.statuses[0].definition.amount).toBe(1)
    expect(second.members.statuses[0].definition.amount).toBe(2)
    expect(first.diagnostics.some(item => item.code === 'conflicting-member')).toBe(false)
    expect(second.diagnostics.some(item => item.code === 'conflicting-member')).toBe(false)
  })

  it('follows applied semantic status records and rules without treating unused records as dependencies', () => {
    const graph: GameplayModuleGraph = {
      version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [{ name: 'success', type: 'boolean' }],
      schemas: [{ id: 'tag', version: '1', fields: [{ name: 'type', type: 'string' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } }] }],
      body: [
        { kind: 'call', id: 'ref', module: 'ref.holder', version: '1' },
        { kind: 'call', id: 'piece', module: 'query.piece', version: '1', inputs: { pieceId: { kind: 'output', node: 'ref', port: 'piece' } } },
        { kind: 'record.create', id: 'tag', schema: 'tag@1', fields: { type: { kind: 'literal', value: 'guard' }, relatedRules: { kind: 'literal', value: ['related-rule'] } } },
        { kind: 'record.create', id: 'unused', schema: 'tag@1', fields: { type: { kind: 'literal', value: 'unused' }, relatedRules: { kind: 'literal', value: ['not-a-dependency'] } } },
        { kind: 'call', id: 'apply', module: 'status.apply-record', version: '1', inputs: { target: { kind: 'output', node: 'piece', port: 'piece' }, record: { kind: 'output', node: 'tag', port: 'value' } }, parameters: { inputPolicy: 'host' } },
        { kind: 'return', id: 'done', values: { success: { kind: 'literal', value: true } } },
      ],
    }
    const skill = applyGameplayModuleGraph({ id: 'probe', kind: 'active' }, graph)
    const input = { skills: { probe: skill }, rules: { 'related-rule': { id: 'related-rule' } }, pieces: {} }
    const result = buildSkillCluster(input, { collection: 'skills', id: 'probe' })
    expect(result.members.statuses.map(status => status.id)).toEqual(['guard'])
    // The author projection keeps explicitly declared related rules visible
    // as reference-only members; this does not install a runtime rule.
    expect(result.members.rules.map(rule => rule.id)).toEqual(['related-rule'])
    expect(result.diagnostics.filter(item => item.code === 'missing-reference')).toEqual([])
    skill.code += '\n'
    const invalid = buildSkillCluster(input, { collection: 'skills', id: 'probe' })
    expect(invalid.members.statuses).toEqual([])
    expect(invalid.members.rules).toEqual([])
  })

  it('follows semantic records applied from a bounded while body', () => {
    const graph: GameplayModuleGraph = {
      version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [{ name: 'success', type: 'boolean' }],
      schemas: [{ id: 'tag', version: '1', fields: [{ name: 'type', type: 'string' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } }] }],
      body: [
        { kind: 'call', id: 'ref', module: 'ref.holder', version: '1' },
        { kind: 'call', id: 'piece', module: 'query.piece', version: '1', inputs: { pieceId: { kind: 'output', node: 'ref', port: 'piece' } } },
        { kind: 'record.create', id: 'tag', schema: 'tag@1', fields: { type: { kind: 'literal', value: 'while-guard' }, relatedRules: { kind: 'literal', value: ['while-rule'] } } },
        { kind: 'while', id: 'apply-once', budget: 1, condition: { body: [{ kind: 'return', id: 'done', value: { kind: 'literal', value: false } }] }, body: [
          { kind: 'call', id: 'apply', module: 'status.apply-record', version: '1', inputs: { target: { kind: 'output', node: 'piece', port: 'piece' }, record: { kind: 'output', node: 'tag', port: 'value' } }, parameters: { inputPolicy: 'host' } },
        ] },
        { kind: 'return', id: 'result', values: { success: { kind: 'literal', value: true } } },
      ],
    }
    const skill = applyGameplayModuleGraph({ id: 'while-probe', kind: 'active' }, graph)
    const result = buildSkillCluster({ skills: { 'while-probe': skill }, rules: { 'while-rule': { id: 'while-rule' } }, pieces: {} }, { collection: 'skills', id: 'while-probe' })
    expect(result.members.statuses.map(status => status.id)).toEqual(['while-guard'])
    expect(result.members.rules.map(rule => rule.id)).toEqual(['while-rule'])
    expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })

  it('expands only called nested composites and isolates their local node IDs', () => {
    const leaf = (id: string, ruleId: string): NonNullable<GameplayModuleGraph['composites']>[number] => ({ id, version: '1', inputs: [], outputs: [{ name: 'success', type: 'boolean' as const }], body: [
      { kind: 'call' as const, id: 'ref', module: 'ref.holder', version: '1' },
      { kind: 'call' as const, id: 'piece', module: 'query.piece', version: '1', inputs: { pieceId: { kind: 'output' as const, node: 'ref', port: 'piece' } } },
      { kind: 'call' as const, id: 'apply', module: 'rule.apply-piece', version: '1', inputs: { target: { kind: 'output' as const, node: 'piece', port: 'piece' } }, parameters: { ruleId } },
      { kind: 'return' as const, id: 'done', values: { success: { kind: 'literal' as const, value: true } } },
    ] })
    const graph: GameplayModuleGraph = { version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [{ name: 'success', type: 'boolean' }], body: [
      { kind: 'call', id: 'first', module: 'local.wrapper', version: '1' }, { kind: 'call', id: 'second', module: 'local.second', version: '1' }, { kind: 'return', id: 'done', values: { success: { kind: 'literal', value: true } } },
    ], composites: [leaf('local.first', 'first-rule'), leaf('local.second', 'second-rule'), leaf('local.unused', 'unused-rule'), { id: 'local.wrapper', version: '1', inputs: [], outputs: [{ name: 'success', type: 'boolean' }], body: [{ kind: 'call', id: 'nested', module: 'local.first', version: '1' }, { kind: 'return', id: 'done', values: { success: { kind: 'literal', value: true } } }] }] }
    const input = { skills: { probe: applyGameplayModuleGraph({ id: 'probe', kind: 'active' }, graph) }, rules: { 'first-rule': { id: 'first-rule' }, 'second-rule': { id: 'second-rule' } }, pieces: {} }
    const result = buildSkillCluster(input, { collection: 'skills', id: 'probe' })
    expect(result.members.rules.map(rule => rule.id)).toEqual(['first-rule', 'second-rule'])
    expect(result.diagnostics.filter(item => item.code === 'missing-reference')).toEqual([])
  })

  it('propagates scoped record evidence through composite inputs and returned records', () => {
    const applyAndReturn: NonNullable<GameplayModuleGraph['composites']>[number] = {
      id: 'local.apply-tag', version: '1',
      inputs: [{ name: 'target', type: 'piece' }, { name: 'record', type: 'record' }],
      outputs: [{ name: 'record', type: 'record' }],
      body: [
        // This local ID intentionally collides with the caller's record ID.
        { kind: 'record.create', id: 'tag', schema: 'tag@1', fields: { type: { kind: 'literal', value: 'local-only' }, relatedRules: { kind: 'literal', value: ['local-only-rule'] } } },
        { kind: 'call', id: 'apply-input', module: 'status.apply-record', version: '1', inputs: { target: { kind: 'input', name: 'target' }, record: { kind: 'input', name: 'record' } }, parameters: { inputPolicy: 'host' } },
        { kind: 'return', id: 'done', value: { kind: 'input', name: 'record' } },
      ],
    }
    const unused: NonNullable<GameplayModuleGraph['composites']>[number] = {
      id: 'local.unused', version: '1',
      inputs: [{ name: 'target', type: 'piece' }],
      outputs: [{ name: 'success', type: 'boolean' }],
      body: [
        { kind: 'record.create', id: 'unused', schema: 'tag@1', fields: { type: { kind: 'literal', value: 'unused' }, relatedRules: { kind: 'literal', value: ['unused-rule'] } } },
        { kind: 'call', id: 'apply-unused', module: 'status.apply-record', version: '1', inputs: { target: { kind: 'input', name: 'target' }, record: { kind: 'output', node: 'unused', port: 'value' } }, parameters: { inputPolicy: 'host' } },
        { kind: 'return', id: 'done', values: { success: { kind: 'literal', value: true } } },
      ],
    }
    const graph: GameplayModuleGraph = {
      version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [{ name: 'success', type: 'boolean' }],
      schemas: [{ id: 'tag', version: '1', fields: [{ name: 'type', type: 'string' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } }] }],
      body: [
        { kind: 'call', id: 'ref', module: 'ref.holder', version: '1' },
        { kind: 'call', id: 'piece', module: 'query.piece', version: '1', inputs: { pieceId: { kind: 'output', node: 'ref', port: 'piece' } } },
        { kind: 'record.create', id: 'tag', schema: 'tag@1', fields: { type: { kind: 'literal', value: 'guard' }, relatedRules: { kind: 'literal', value: ['composite-rule'] } } },
        { kind: 'record.create', id: 'unused-root', schema: 'tag@1', fields: { type: { kind: 'literal', value: 'unused' }, relatedRules: { kind: 'literal', value: ['unused-root-rule'] } } },
        { kind: 'call', id: 'apply', module: 'local.apply-tag', version: '1', inputs: { target: { kind: 'output', node: 'piece', port: 'piece' }, record: { kind: 'output', node: 'tag', port: 'value' } } },
        { kind: 'call', id: 'apply-returned', module: 'status.apply-record', version: '1', inputs: { target: { kind: 'output', node: 'piece', port: 'piece' }, record: { kind: 'output', node: 'apply', port: 'record' } }, parameters: { inputPolicy: 'host' } },
        { kind: 'return', id: 'done', values: { success: { kind: 'literal', value: true } } },
      ],
      composites: [applyAndReturn, unused],
    }
    const skill = applyGameplayModuleGraph({ id: 'probe', kind: 'active' }, graph)
    const result = buildSkillCluster({
      skills: { probe: skill },
      rules: { 'composite-rule': { id: 'composite-rule' } },
      pieces: {},
    }, { collection: 'skills', id: 'probe' })

    expect(result.members.statuses.map(status => status.id)).toEqual(['guard'])
    expect(result.members.statuses[0].provenance.some(item => item.path.includes('composites[0].body'))).toBe(true)
    expect(result.members.statuses[0].provenance.some(item => item.path.includes('.body[5]'))).toBe(true)
    expect(result.members.rules.map(rule => rule.id)).toEqual(['composite-rule'])
    expect(result.diagnostics.filter(item => item.code === 'missing-reference')).toEqual([])
  })

  it('keeps status node IDs local to each reachable continuation', () => {
    const tagGraph = (status: string, ruleId: string, surface: 'skill' | 'pending'): GameplayModuleGraph => ({ version: 'rvb-gameplay-modules/v1', surface, outputs: [{ name: 'success', type: 'boolean' }], schemas: [{ id: 'tag', version: '1', fields: [{ name: 'type', type: 'string' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } }] }], body: [
      { kind: 'call', id: 'ref', module: 'ref.holder', version: '1' }, { kind: 'call', id: 'piece', module: 'query.piece', version: '1', inputs: { pieceId: { kind: 'output', node: 'ref', port: 'piece' } } },
      { kind: 'record.create', id: 'tag', schema: 'tag@1', fields: { type: { kind: 'literal', value: status }, relatedRules: { kind: 'literal', value: [ruleId] } } },
      { kind: 'call', id: 'apply', module: 'status.apply-record', version: '1', inputs: { target: { kind: 'output', node: 'piece', port: 'piece' }, record: { kind: 'output', node: 'tag', port: 'value' } }, parameters: { inputPolicy: 'host' } },
      ...(surface === 'pending' ? [{ kind: 'return' as const, id: 'done', values: { success: { kind: 'literal' as const, value: true } } }] : []),
    ] })
    const root = tagGraph('root-status', 'root-rule', 'skill')
    const graph: GameplayModuleGraph = { ...root, schemas: [...root.schemas!, { id: 'payload', version: '1', fields: [] }], body: [...root.body,
      { kind: 'record.create', id: 'payload', schema: 'payload@1', fields: {} }, { kind: 'defer-choice', id: 'choose', graph: 'next@1', payload: { kind: 'output', node: 'payload', port: 'value' } },
      { kind: 'return', id: 'done', values: { success: { kind: 'literal', value: true } } },
    ], continuations: [{ id: 'next', version: '1', payloadType: { kind: 'record', schema: 'payload@1' }, graph: tagGraph('child-status', 'child-rule', 'pending') }, { id: 'next', version: '2', graph: tagGraph('other-version-status', 'other-version-rule', 'pending') }, { id: 'unused', version: '1', graph: tagGraph('unused-status', 'unused-rule', 'pending') }] }
    const input = { skills: { probe: applyGameplayModuleGraph({ id: 'probe', kind: 'active' }, graph) }, rules: { 'root-rule': { id: 'root-rule' }, 'child-rule': { id: 'child-rule' } }, pieces: {} }
    const result = buildSkillCluster(input, { collection: 'skills', id: 'probe' })
    expect(result.members.statuses.map(status => status.id)).toEqual(['root-status', 'child-status'])
    expect(result.members.rules.map(rule => rule.id)).toEqual(['root-rule', 'child-rule'])
    expect(result.diagnostics.filter(item => item.code === 'missing-reference')).toEqual([])
  })

  it('does not treat a preview-only module entry as semantic runtime coverage', () => {
    const result = buildSkillCluster({
      skills: {
        previewOnly: {
          id: 'previewOnly',
          kind: 'active',
          code: 'legacy runtime',
          gameplayModules: {
            version: 'rvb-gameplay-module-document/v1',
            entries: {
              previewCode: {
                compilerVersion: 'rvb-gameplay-module-compiler/v1',
                graph: { version: 'rvb-gameplay-modules/v1', surface: 'preview', body: [] },
              },
            },
          },
        },
      },
      rules: {},
      pieces: {},
    }, { collection: 'skills', id: 'previewOnly' })
    expect(result.members.skills[0].evidence).toBe('declarative')
    expect(result.coverage.semantic.status).toBe('missing')
    expect(result.coverage.compatibility.status).toBe('partial')
  })

  it('follows declarative Rule triggerSkill references without registering another execution source', () => {
    const input = { skills: { root: { id: 'root', kind: 'passive', relatedRules: ['trigger'] }, reaction: { id: 'reaction', kind: 'passive' } }, rules: { trigger: { id: 'trigger', effect: { type: 'triggerSkill', skillId: 'reaction' } } }, pieces: {} }
    const cluster = buildSkillCluster(input, { collection: 'skills', id: 'root' })
    expect(cluster.members.skills.map(item => item.id)).toEqual(['root', 'reaction'])
    expect(cluster.members.skills.find(item => item.id === 'reaction')?.execution).toBe('reference-only')
    input.rules.trigger.effect.skillId = 'missing'
    expect(buildSkillCluster(input, { collection: 'skills', id: 'root' }).diagnostics.some(item => item.code === 'missing-reference' && item.reference === 'missing')).toBe(true)
  })

  it('requires compiled runtime equality before reporting semantic completion', () => {
    const graph = { version: 'rvb-gameplay-modules/v1', surface: 'skill', body: [] }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    const skill: JsonRecord = { id: 'probe', kind: 'active', code: compiled.code, gameplayModules: { version: 'rvb-gameplay-module-document/v1', entries: { code: { compilerVersion: compiled.compilerVersion, graph } } } }
    const inspect = () => buildSkillCluster({ skills: { probe: skill }, pieces: {}, rules: {} }, { collection: 'skills', id: 'probe' }).coverage.semantic.status
    expect(inspect()).toBe('complete')
    skill.code = 'stale source'
    expect(inspect()).toBe('missing')
    graph.body.push({ kind: 'not-valid' } as never)
    expect(inspect()).toBe('missing')
  })

  it('validates unsafe fields and does not mutate catalog data or discard metadata', () => {
    const skill = {
      id: 'safe', kind: 'active', statusTag: { id: 'tag', type: 'tag' },
      futureMetadata: { keep: true },
    }
    const input = { skills: { safe: skill }, rules: {}, pieces: {} }
    const before = JSON.stringify(input)
    const result = buildSkillCluster(input, { collection: 'skills', id: 'safe', field: '__proto__.constructor' }, { metadata: { future: { keep: 'yes' } } })
    expect(result.diagnostics.some(item => item.code === 'unsafe-field-path')).toBe(true)
    expect(result.members.skills[0].definition.futureMetadata).toEqual({ keep: true })
    expect(result.metadata).toEqual({ future: { keep: 'yes' } })
    ;(result.members.skills[0].definition.futureMetadata as JsonRecord).keep = false
    expect(JSON.stringify(input)).toBe(before)

    const valid = buildSkillCluster(input, { collection: 'skills', id: 'safe' }, { metadata: { unknownEditorKey: 7 } })
    expect(validateSkillClusterDefinition(valid)).toEqual([])
    expect(validateSkillClusterDefinition({ ...valid, metadata: { unknownEditorKey: 7, future: true } })).toEqual([])
  })

  it('reports invalid persisted Cluster envelopes and links without executing them', () => {
    const result = buildSkillCluster({
      skills: {
        root: {
          id: 'root',
          kind: 'passive',
          cluster: {
            version: 'future/v2',
            id: 'skills:other',
            links: [
              { collection: 'rules', id: 'missing', relation: 'owned' },
              { collection: 'unknown', id: 'x', relation: 'owned' },
            ],
            unknownEditorKey: { preserve: true },
          },
        },
      },
      rules: {},
      pieces: {},
    }, { collection: 'skills', id: 'root' })
    expect(result.members.rules).toHaveLength(0)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'invalid-definition',
      'invalid-reference',
    ]))
    expect(() => assertSkillClusterMetadata({
      id: 'root',
      cluster: { version: SKILL_CLUSTER_DEFINITION_VERSION, id: 'cards:root', links: [] },
    })).not.toThrow()
    expect(() => assertSkillClusterMetadata({
      id: 'root',
      cluster: { version: 'future/v2', id: 'skills:root', links: [] },
    })).toThrow('unsupported persisted cluster version')
    expect(() => assertSkillClusterMetadata({
      id: 'root',
      cluster: { version: SKILL_CLUSTER_DEFINITION_VERSION, id: 'skills:root', links: [{ collection: 'rules', id: 'rule', relation: 'owned' }] },
    })).not.toThrow()
  })

  it('builds both skill and independent piece roots with one shared definition snapshot', () => {
    const input = {
      skills: { active: { id: 'active', kind: 'active', relatedRules: ['shared'] } },
      rules: { shared: { id: 'shared' } },
      pieces: { piece: { id: 'piece', rules: ['shared'] } },
      cards: { card: { id: 'card', kind: 'active', rules: ['shared'] } },
    }
    const catalogView = buildSkillClusterCatalog(input)
    expect(catalogView.clusters.map(cluster => cluster.clusterId)).toEqual(['skills:active', 'pieces:piece', 'rules:shared', 'cards:card'])
    expect(catalogView.definitions).toBe(catalogView.clusters)
    expect(catalogView.clusters[0].members.rules).toHaveLength(1)
    expect(catalogView.clusters[1].members.rules).toHaveLength(1)
    expect(catalogView.clusters[3].members.rules).toHaveLength(1)
    expect(catalogView.clusters[0].execution).toBe('reference-only')
  })

  it('builds rule and card roots as reference-only passive or active Clusters', () => {
    const input = {
      skills: { skill: { id: 'skill', kind: 'active' } },
      rules: { rootRule: { id: 'rootRule', skills: ['skill'], extension: { source: 'rule', nested: { unknown: true } } } },
      pieces: {},
      cards: { rootCard: { id: 'rootCard', kind: 'passive', rules: ['rootRule'], extension: { source: 'card' } } },
    }
    const ruleCluster = buildSkillCluster(input, { collection: 'rules', id: 'rootRule' })
    expect(ruleCluster.kind).toBe('passive')
    expect(ruleCluster.members.rules.map(member => member.id)).toEqual(['rootRule'])
    expect(ruleCluster.members.skills.map(member => member.id)).toEqual(['skill'])
    expect(ruleCluster.members.extensions).toHaveLength(1)
    expect(ruleCluster.execution).toBe('reference-only')

    const cardCluster = buildSkillCluster(input, { collection: 'cards', id: 'rootCard' })
    expect(cardCluster.kind).toBe('passive')
    expect(cardCluster.members.cards.map(member => member.id)).toEqual(['rootCard'])
    expect(cardCluster.members.rules.map(member => member.id)).toEqual(['rootRule'])
    expect(cardCluster.members.extensions[0].source?.path).toBe('cards.rootCard.extension')
    expect(cardCluster.members.all.every(member => member.execution === 'reference-only')).toBe(true)
  })

  it('projects Rules related by an applied semantic StatusTag from a Card root', () => {
    const graph: GameplayModuleGraph = {
      version: 'rvb-gameplay-modules/v1', surface: 'card', outputs: [{ name: 'success', type: 'boolean' }],
      schemas: [{ id: 'tag', version: '1', fields: [{ name: 'type', type: 'string' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } }] }],
      body: [
        { kind: 'call', id: 'ref', module: 'ref.holder', version: '1' },
        { kind: 'call', id: 'piece', module: 'query.piece', version: '1', inputs: { pieceId: { kind: 'output', node: 'ref', port: 'piece' } } },
        { kind: 'record.create', id: 'tag', schema: 'tag@1', fields: { type: { kind: 'literal', value: 'card-guard' }, relatedRules: { kind: 'literal', value: ['card-rule'] } } },
        { kind: 'call', id: 'apply', module: 'status.apply-record', version: '1', inputs: { target: { kind: 'output', node: 'piece', port: 'piece' }, record: { kind: 'output', node: 'tag', port: 'value' } }, parameters: { inputPolicy: 'host' } },
        { kind: 'return', id: 'done', values: { success: { kind: 'literal', value: true } } },
      ],
    }
    const card = applyGameplayModuleGraph({ id: 'card', kind: 'active' }, graph)
    const result = buildSkillCluster({ skills: {}, rules: { 'card-rule': { id: 'card-rule' } }, pieces: {}, cards: { card } }, { collection: 'cards', id: 'card' })
    expect(result.members.statuses.map(status => status.id)).toEqual(['card-guard'])
    expect(result.members.rules.map(rule => rule.id)).toEqual(['card-rule'])
    expect(result.members.rules[0].execution).toBe('reference-only')
  })

  it('keeps owner-scoped extension snapshots safe and preserves nested unknown fields', () => {
    const root = JSON.parse('{"id":"root","kind":"active","skills":["child"],"extension":{"nested":{"futureField":[1,{"kept":true}]},"__proto__":{"polluted":true}}}') as JsonRecord
    const child = { id: 'child', kind: 'passive', extension: { nested: { childOnly: true } } }
    const input = { skills: { root, child }, rules: {}, pieces: {} }
    const before = JSON.stringify(input)
    const result = buildSkillCluster(input, { collection: 'skills', id: 'root' })
    expect(result.members.extensions).toHaveLength(2)
    const rootExtension = result.members.extensions.find(member => member.source?.path === 'skills.root.extension')
    expect(rootExtension?.definition).toMatchObject({ nested: { futureField: [1, { kept: true }] } })
    expect(Object.prototype.hasOwnProperty.call(rootExtension?.definition ?? {}, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(rootExtension?.definition)).toBe(Object.prototype)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect(JSON.stringify(input)).toBe(before)
  })

  it('retains the strongest explicit membership relation after dependency traversal', () => {
    const result = buildSkillCluster({
      skills: {
        root: {
          id: 'root', kind: 'active', rules: ['shared-rule'],
          cluster: { links: [{ collection: 'rules', id: 'shared-rule', relation: 'owned', source: 'review' }] },
        },
      },
      rules: { 'shared-rule': { id: 'shared-rule' } },
      pieces: {},
    }, { collection: 'skills', id: 'root' })
    expect(result.members.rules[0]).toMatchObject({ id: 'shared-rule', relation: 'owned' })
    expect(result.members.rules[0].execution).toBe('reference-only')
  })

  it('can limit catalog menu roots without changing universal single-root support', () => {
    const input = {
      skills: { skill: { id: 'skill', kind: 'active' } },
      rules: { rule: { id: 'rule' } },
      pieces: {},
      cards: { card: { id: 'card' } },
    }
    const rulesOnly = buildSkillClusterCatalog(input, { rootCollections: ['rules'] })
    expect(rulesOnly.clusters.map(cluster => cluster.clusterId)).toEqual(['rules:rule'])
    expect(buildSkillCluster(input, { collection: 'cards', id: 'card' }).members.cards).toHaveLength(1)
  })

  it('traverses piece-root Cluster links and retains explicit relation provenance', () => {
    const input = {
      skills: {
        linked: {
          id: 'linked',
          kind: 'active',
          cluster: {
            links: [{ collection: 'rules', id: 'linked-rule', relation: 'owned', source: 'skill-review' }],
          },
        },
      },
      rules: {
        'linked-rule': { id: 'linked-rule' },
        'piece-rule': { id: 'piece-rule' },
      },
      pieces: {
        root: {
          id: 'root',
          cluster: {
            links: [
              { collection: 'skills', id: 'linked', relation: 'shared', source: 'piece-review' },
              { collection: 'pieces', id: 'helper', relation: 'related' },
              { collection: 'rules', id: 'piece-rule', relation: 'owned' },
              { collection: 'rules', id: 'missing-piece-rule', relation: 'owned' },
            ],
          },
        },
        helper: { id: 'helper', rules: [] },
      },
    }

    const result = buildSkillCluster(input, { collection: 'pieces', id: 'root' })
    expect(result.members.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'linked', relation: 'shared' }),
    ]))
    expect(result.members.pieces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'helper', relation: 'related' }),
    ]))
    expect(result.members.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'piece-rule', relation: 'owned' }),
      expect.objectContaining({ id: 'linked-rule', relation: 'owned' }),
    ]))
    expect(result.diagnostics.some(item => item.code === 'missing-reference' && item.reference === 'missing-piece-rule')).toBe(true)
    expect(result.members.skills.find(member => member.id === 'linked')?.provenance.some(location => location.path.includes('piece-review'))).toBe(true)
  })
})
