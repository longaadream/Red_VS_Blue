import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPieceAbilityGroups, type SkillClusterCatalogInput } from '../../lib/skill-graph/module-document'
import { planAuthorClusterInitialization } from '../../lib/game/author-cluster-initialization'

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
    cards: table(files.cards),
  }
}

describe('piece ability group projection', () => {
  it('does not adopt a related skill descendant as the root ability own rule', () => {
    const piece = { id: 'p', skills: ['a'], rules: ['r'] }
    const input: SkillClusterCatalogInput = {
      pieces: { p: piece }, cards: {}, rules: { r: { id: 'r' } },
      skills: {
        a: { id: 'a', cluster: { version: 'rvb-skill-cluster/v1', id: 'skills:a', links: [
          { collection: 'skills', id: 'b', relation: 'related' },
        ] } },
        b: { id: 'b', cluster: { version: 'rvb-skill-cluster/v1', id: 'skills:b', links: [
          { collection: 'rules', id: 'r', relation: 'owned' },
        ] } },
      },
    }
    const projection = buildPieceAbilityGroups(input, 'p')
    expect(projection.groups.map(group => group.id)).toEqual(['skills:a', 'rules:r'])
    expect(projection.groups[0].directRuleIds).toEqual([])
    expect(projection.groups[0].members.rules.map(rule => rule.id)).toContain('r')
    expect(planAuthorClusterInitialization(piece, input).definitions.map(group => group.id)).toEqual(projection.groups.map(group => group.id))
  })
  it('keeps a related rule as an independent ability, matching runtime ownership', () => {
    const piece = { id: 'p', skills: ['s'], rules: ['r'] }
    const input: SkillClusterCatalogInput = {
      pieces: { p: piece }, cards: {}, rules: { r: { id: 'r' } },
      skills: { s: { id: 's', kind: 'active', cluster: { version: 'rvb-skill-cluster/v1', id: 'skills:s', links: [
        { collection: 'rules', id: 'r', relation: 'related' },
      ] } } },
    }
    const projection = buildPieceAbilityGroups(input, 'p')
    expect(projection.groups.map(group => group.id)).toEqual(['skills:s', 'rules:r'])
    expect(projection.groups[0].directRuleIds).toEqual([])
    expect(projection.groups[0].members.rules.map(rule => rule.id)).toContain('r')
    expect(planAuthorClusterInitialization(piece, input).definitions.map(group => group.id)).toEqual(projection.groups.map(group => group.id))
  })
  it('persists exact card graph links for ordinary skill roots and generated card closures', () => {
    const expected: Record<string, Array<[string, string, 'owned' | 'shared']>> = {
      'elune-blessing': [
        ['holy-smite', 'skills.elune-blessing.gameplayModules.entries.code.graph.body[5].inputs.items.value[0]', 'shared'],
        ['holy-heal', 'skills.elune-blessing.gameplayModules.entries.code.graph.body[5].inputs.items.value[1]', 'shared'],
        ['holy-charge', 'skills.elune-blessing.gameplayModules.entries.code.graph.body[5].inputs.items.value[2]', 'shared'],
      ],
      'watcher-ultimate': [
        ['watcher-calm', 'skills.watcher-ultimate.gameplayModules.entries.code.graph.body[5].body[2].then[0].parameters.cardId', 'owned'],
        ['watcher-rage', 'skills.watcher-ultimate.gameplayModules.entries.code.graph.body[5].body[2].else[0].parameters.cardId', 'owned'],
      ],
      'hashirama-edo-sage-buddha': [
        ['hashirama-edo-thousand-hands', 'skills.hashirama-edo-sage-buddha.gameplayModules.entries.code.graph.body[7].then[1].then[1].then[18].body[1].inputs.right.value', 'owned'],
        ['hashirama-edo-nature-heal', 'skills.hashirama-edo-sage-buddha.gameplayModules.entries.code.graph.body[7].then[1].then[1].then[25].body[1].inputs.right.value', 'owned'],
      ],
      'kiljaedan-demonic-pact': [
        ['demon-summon-1', 'skills.kiljaedan-demonic-pact.gameplayModules.entries.code.graph.body[26].parameters.cardId', 'owned'],
        ['demon-summon-2', 'cards.demon-summon-1.gameplayModules.entries.code.graph.body[11].parameters.cardId', 'owned'],
        ['demon-summon-3', 'cards.demon-summon-2.gameplayModules.entries.code.graph.body[11].parameters.cardId', 'owned'],
        ['demon-summon-4', 'cards.demon-summon-3.gameplayModules.entries.code.graph.body[11].parameters.cardId', 'owned'],
        ['demon-summon-5', 'cards.demon-summon-4.gameplayModules.entries.code.graph.body[11].parameters.cardId', 'owned'],
      ],
      'soul-fracture': [
        ['soul-fragment', 'rules.rule-soul-fracture-player.gameplayModules.entries.skillCode.graph.body[7].parameters.cardId', 'owned'],
      ],
      'rafaam-curse-ward': [
        ['rafaam-curse-sample', 'rules.rule-rafaam-curse-ward.gameplayModules.entries.skillCode.graph.body[3].then[4].then[5].then[34].then[14].inputs.templateId.value', 'owned'],
      ],
      'rafaam-curse-amplify': [
        ['rafaam-curse-sample', 'scripts/audit-content-graph-coverage.mjs:dynamicResolution.copySourceProof.ordinaryCurseIds', 'shared'],
      ],
      'light-extraction': [
        ['holy-smite', 'skills.light-extraction.gameplayModules.entries.code.graph.body[18].parameters.cardId', 'shared'],
        ['holy-heal', 'skills.light-extraction.gameplayModules.entries.code.graph.body[19].parameters.cardId', 'shared'],
      ],
      'turalyon-expedition-order': [
        ['holy-smite', 'skills.turalyon-expedition-order.gameplayModules.entries.code.graph.body[30].then[0].parameters.cardId', 'shared'],
        ['holy-heal', 'skills.turalyon-expedition-order.gameplayModules.entries.code.graph.body[30].else[0].then[0].parameters.cardId', 'shared'],
        ['holy-charge', 'skills.turalyon-expedition-order.gameplayModules.entries.code.graph.body[30].else[0].else[0].then[0].parameters.cardId', 'shared'],
      ],
      'velen-holy-prophecy': [
        ['holy-smite', 'skills.velen-holy-prophecy.gameplayModules.entries.code.graph.body[12].then[0].body[9].inputs.right.value', 'shared'],
        ['holy-heal', 'skills.velen-holy-prophecy.gameplayModules.entries.code.graph.body[12].then[0].body[10].inputs.right.value', 'shared'],
        ['holy-charge', 'skills.velen-holy-prophecy.gameplayModules.entries.code.graph.body[12].then[0].body[11].inputs.right.value', 'shared'],
      ],
      'velen-thousand-futures-ultimate': [
        ['holy-smite', 'skills.velen-thousand-futures-ultimate.gameplayModules.entries.code.graph.body[12].then[5].then[2].then[4].else[4].else[4].then[0].body[6].inputs.right.value', 'shared'],
        ['holy-heal', 'skills.velen-thousand-futures-ultimate.gameplayModules.entries.code.graph.body[12].then[5].then[2].then[4].else[4].else[4].then[0].body[7].inputs.right.value', 'shared'],
        ['holy-charge', 'skills.velen-thousand-futures-ultimate.gameplayModules.entries.code.graph.body[12].then[5].then[2].then[4].else[4].else[4].then[0].body[8].inputs.right.value', 'shared'],
      ],
    }
    for (const [skillId, rows] of Object.entries(expected)) {
      const links = ((load(`data/skills/${skillId}.json`).cluster as JsonRecord).links as JsonRecord[]).filter(link => link.collection === 'cards')
      expect(links.map(link => [link.id, link.source, link.relation])).toEqual(rows)
    }
  })

  it('keeps watcher card calls in the complete skill group with exact source metadata', () => {
    const piece = load('data/pieces/blue-watcher.json')
    const result = buildPieceAbilityGroups(catalog({
      skills: ['data/skills/watcher-form.json', 'data/skills/watcher-ultimate.json'],
      pieces: ['data/pieces/blue-watcher.json'],
      cards: ['data/cards/watcher-calm.json', 'data/cards/watcher-rage.json'],
      rules: ['data/rules/rule-watcher-form.json'],
    }), piece)
    const ultimate = result.groups.find(group => group.id === 'skills:watcher-ultimate')
    expect(ultimate?.cluster.members.cards.map(member => member.id)).toEqual(['watcher-calm', 'watcher-rage'])
    expect(ultimate?.cluster.members.cards.every(member => member.provenance.some(location => location.path.includes('skills.watcher-ultimate.gameplayModules.entries.code.graph')))).toBe(true)
    expect(result.groups).toHaveLength(2)
    expect(result.execution).toBe('reference-only')
  })

  it('projects the complete five-card demon summon chain from the skill root', () => {
    const result = buildPieceAbilityGroups(catalog({
      skills: ['data/skills/kiljaedan-demonic-pact.json'],
      pieces: ['data/pieces/kiljaedan.json'],
      rules: ['data/rules/rule-kiljaedan-gamestart.json'],
      cards: [1, 2, 3, 4, 5].map(index => `data/cards/demon-summon-${index}.json`),
    }), 'kiljaedan')
    const pact = result.groups.find(group => group.id === 'skills:kiljaedan-demonic-pact')
    expect(pact?.cluster.members.cards.map(member => member.id)).toEqual([
      'demon-summon-1',
      'demon-summon-2',
      'demon-summon-3',
      'demon-summon-4',
      'demon-summon-5',
    ])
    expect(pact?.cluster.members.cards.every(member => member.relation === 'owned')).toBe(true)
    expect(result.unassignedRuleIds).toEqual([])
  })

  it('shares Jaina freeze rules across skill groups and does not create a standalone rule root', () => {
    const result = buildPieceAbilityGroups(catalog({
      skills: [
        'data/skills/frostbolt.json',
        'data/skills/fireball.json',
        'data/skills/blizzard.json',
        'data/skills/blizzard-damage.json',
      ],
      pieces: ['data/pieces/jaina.json'],
      rules: ['data/rules/rule-freeze-prevent-move.json', 'data/rules/rule-freeze-prevent-skill.json'],
    }), 'jaina')
    expect(result.directSkillIds).toEqual(['frostbolt', 'fireball', 'blizzard'])
    expect(result.unassignedRuleIds).toEqual([])
    expect(result.groups.filter(group => group.unassigned)).toEqual([])
    expect(result.groups.find(group => group.id === 'skills:frostbolt')?.directRuleIds).toEqual([
      'rule-freeze-prevent-move',
      'rule-freeze-prevent-skill',
    ])
    expect(result.groups.find(group => group.id === 'skills:blizzard')?.directRuleIds).toEqual([
      'rule-freeze-prevent-move',
      'rule-freeze-prevent-skill',
    ])
  })

  it('keeps a direct rule without a skill graph owner as a visible passive group', () => {
    const result = buildPieceAbilityGroups(catalog({
      skills: [
        'data/skills/naruto-shadow-clone.json',
      ],
      pieces: ['data/pieces/blue-naruto.json'],
      rules: [
        'data/rules/rule-naruto-clone-died.json',
        'data/rules/rule-naruto-clone-immobile.json',
        'data/rules/rule-naruto-clone-one-hit.json',
        'data/rules/rule-naruto-clone-endturn-charge.json',
      ],
    }), 'blue-naruto')
    expect(result.unassignedRuleIds).toEqual(['rule-naruto-clone-endturn-charge'])
    expect(result.groups.at(-1)).toMatchObject({
      id: 'rules:rule-naruto-clone-endturn-charge',
      kind: 'rule',
      unassigned: true,
      directRuleIds: ['rule-naruto-clone-endturn-charge'],
    })
  })

  it('inherits the Naruto compatibility rule when the Sage Mode definition is present', () => {
    const result = buildPieceAbilityGroups(catalog({
      skills: [
        'data/skills/naruto-sage-mode.json',
      ],
      pieces: ['data/pieces/blue-naruto.json'],
      rules: ['data/rules/rule-naruto-clone-endturn-charge.json'],
    }), {
      ...load('data/pieces/blue-naruto.json'),
      skills: ['naruto-sage-mode'],
      rules: ['rule-naruto-clone-endturn-charge'],
    })
    expect(result.unassignedRuleIds).toEqual([])
    expect(result.groups.map(group => group.id)).toEqual(['skills:naruto-sage-mode'])
    const sageMode = result.groups[0]
    expect(sageMode.directRuleIds).toEqual(['rule-naruto-clone-endturn-charge'])
    expect(sageMode.cluster.members.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rule-naruto-clone-endturn-charge', relation: 'owned' }),
    ]))
    expect(sageMode.cluster.members.rules.find(rule => rule.id === 'rule-naruto-clone-endturn-charge')?.definition).toMatchObject({
      id: 'rule-naruto-clone-endturn-charge',
    })
  })

  it('keeps all audited auxiliary rules in complete skill groups', () => {
    const cases: Array<{
      pieceId: string
      skillIds: string[]
      ruleIds: string[]
      relations: Record<string, 'owned' | 'shared'>
      coveredBy?: Record<string, string[]>
      triggerSkillIds?: string[]
    }> = [
      {
        pieceId: 'blue-ichigo',
        skillIds: ['ichigo-black-getsuga-tensho'],
        ruleIds: ['rule-ichigo-black-getsuga-teleport'],
        relations: { 'rule-ichigo-black-getsuga-teleport': 'owned' },
      },
      {
        pieceId: 'blue-ichigo-transformed',
        skillIds: ['ichigo-getsuga-tensho'],
        ruleIds: ['rule-ichigo-black-getsuga-teleport'],
        relations: { 'rule-ichigo-black-getsuga-teleport': 'shared' },
      },
      {
        pieceId: 'colt',
        skillIds: ['colt-revolver', 'colt-bullet-storm'],
        ruleIds: ['rule-colt-zone-endturn'],
        relations: { 'rule-colt-zone-endturn': 'shared' },
      },
      {
        pieceId: 'dark-aizen',
        skillIds: ['aizen-kyoka-suiguetsu'],
        ruleIds: ['rule-aizen-kyoka-rewrite', 'rule-aizen-kyoka-expire'],
        relations: { 'rule-aizen-kyoka-rewrite': 'owned', 'rule-aizen-kyoka-expire': 'owned' },
      },
      {
        pieceId: 'dark-akaza',
        skillIds: ['akaza-disorder', 'akaza-flash-step'],
        ruleIds: ['rule-akaza-damage-mark'],
        relations: { 'rule-akaza-damage-mark': 'shared' },
      },
      {
        pieceId: 'mangekyo-probe',
        skillIds: ['itachi-totsuka-blade', 'obito-space-time', 'sasuke-susanoo'],
        ruleIds: ['rule-mangekyo-friendly-death'],
        relations: { 'rule-mangekyo-friendly-death': 'shared' },
      },
      {
        pieceId: 'red-shishio',
        skillIds: ['shishio-infinite-blade', 'shishio-flame-spirit'],
        ruleIds: ['rule-shishio-infinite-blade-recast', 'rule-shishio-kill-track'],
        relations: { 'rule-shishio-infinite-blade-recast': 'owned', 'rule-shishio-kill-track': 'shared' },
        coveredBy: { 'rule-shishio-infinite-blade-recast': ['shishio-infinite-blade'] },
      },
      {
        pieceId: 'tracer',
        skillIds: ['recall'],
        ruleIds: ['rule-recall-skill', 'rule-recall-move', 'rule-recall-endturn'],
        relations: { 'rule-recall-skill': 'owned', 'rule-recall-move': 'owned', 'rule-recall-endturn': 'owned' },
        triggerSkillIds: ['recall-skill-trigger', 'recall-move-trigger', 'recall-endturn-trigger'],
      },
      {
        pieceId: 'velen',
        skillIds: ['velen-holy-prophecy', 'velen-fate-shelter'],
        ruleIds: ['rule-velen-delayed-effects', 'rule-velen-death-cleanup'],
        relations: { 'rule-velen-delayed-effects': 'shared', 'rule-velen-death-cleanup': 'shared' },
      },
    ]

    for (const testCase of cases) {
      const skillFiles = testCase.skillIds.map(id => `data/skills/${id}.json`)
      const ruleFiles = testCase.ruleIds.map(id => `data/rules/${id}.json`)
      const triggerSkillFiles = (testCase.triggerSkillIds || []).map(id => `data/skills/${id}.json`)
      const input = catalog({
        skills: [...skillFiles, ...triggerSkillFiles],
        pieces: [],
        rules: ruleFiles,
      })
      const piece = {
        id: testCase.pieceId,
        skills: testCase.skillIds,
        rules: testCase.ruleIds,
      }
      const result = buildPieceAbilityGroups({ ...input, pieces: { [testCase.pieceId]: piece } }, piece)
      expect(result.unassignedRuleIds, testCase.pieceId).toEqual([])
      expect(result.groups.filter(group => group.unassigned), testCase.pieceId).toEqual([])
      for (const skillId of testCase.skillIds) {
        const group = result.groups.find(candidate => candidate.id === `skills:${skillId}`)
        expect(group, `${testCase.pieceId}:${skillId}`).toBeDefined()
        const expectedRuleIds = testCase.ruleIds.filter(ruleId => testCase.relations[ruleId] === 'shared'
          || (testCase.coveredBy?.[ruleId] || [testCase.skillIds[0]]).includes(skillId))
        expect(group?.directRuleIds, `${testCase.pieceId}:${skillId}`).toEqual(expectedRuleIds)
        expect(group?.cluster.members.rules, `${testCase.pieceId}:${skillId}`).toEqual(expect.arrayContaining(
          expectedRuleIds.map(ruleId => expect.objectContaining({
            id: ruleId,
            relation: testCase.relations[ruleId],
            definition: expect.objectContaining({ id: ruleId }),
          })),
        ))
      }
      const firstGroup = result.groups.find(candidate => candidate.id === `skills:${testCase.skillIds[0]}`)
      if (testCase.triggerSkillIds) {
        expect(firstGroup?.cluster.members.skills.map(skill => skill.id)).toEqual(expect.arrayContaining(testCase.triggerSkillIds))
      }
    }
  })

  it('excludes PVE-only pieces without changing the source catalog', () => {
    const piece = { id: 'pve-probe', availability: { modes: ['pve'] }, skills: ['missing-skill'], rules: ['missing-rule'] }
    const input = { skills: {}, rules: {}, pieces: { 'pve-probe': piece }, cards: {} }
    const result = buildPieceAbilityGroups(input, piece)
    expect(result.excluded).toMatchObject({ reason: 'pve-only', path: 'id' })
    expect(result.groups).toEqual([])
    expect(input.pieces['pve-probe']).toBe(piece)
  })

  it('projects unsaved piece membership from the draft object', () => {
    const existing = load('data/pieces/jaina.json')
    const input = catalog({
      skills: ['data/skills/frostbolt.json', 'data/skills/fireball.json'],
      pieces: ['data/pieces/jaina.json'],
    })
    const draft = { ...existing, skills: ['fireball'], rules: [] }
    const result = buildPieceAbilityGroups(input, draft)
    expect(result.directSkillIds).toEqual(['fireball'])
    expect(result.groups.map(group => group.id)).toEqual(['skills:fireball'])
  })
})
