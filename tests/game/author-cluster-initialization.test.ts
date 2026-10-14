import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AUTHOR_CLUSTER_DEFINITION_VERSION,
  planAuthorClusterInitialization,
  type AuthorClusterInitializationCatalog,
} from '../../lib/game/author-cluster-initialization'

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as Record<string, unknown>
}

function definitionById(value: ReturnType<typeof planAuthorClusterInitialization>, id: string) {
  return value.definitions.find(definition => definition.id === id)
}

function directIds(value: unknown, kind: 'skill' | 'rule'): string[] {
  if (!Array.isArray(value)) return []
  const key = kind === 'skill' ? 'skillId' : 'id'
  return value.flatMap(member => {
    if (typeof member === 'string') return [member]
    if (member && typeof member === 'object' && !Array.isArray(member) && typeof (member as Record<string, unknown>)[key] === 'string') {
      return [(member as Record<string, string>)[key]]
    }
    return []
  })
}

function fixtureCatalog(): AuthorClusterInitializationCatalog {
  const skillManifest = readJson('data/skills/manifest.json') as unknown as string[]
  const ruleManifest = readJson('data/rules/manifest.json') as unknown as string[]
  const skills: Record<string, unknown> = {}
  for (const id of skillManifest) skills[id] = readJson(`data/skills/${id}.json`)
  const rules: Record<string, unknown> = {}
  for (const id of ruleManifest) rules[id] = readJson(`data/rules/${id}.json`)
  return { skills, rules }
}

describe('author Cluster initialization planner', () => {
  it('groups linked rules under complete abilities and keeps unassigned rule roots', () => {
    const result = planAuthorClusterInitialization(
      {
        skills: [{ skillId: 'root-skill' }, { skillId: 'linked-skill' }],
        rules: [{ id: 'linked-rule' }, { id: 'rule-root' }],
      },
      {
        skills: {
          'root-skill': {
            id: 'root-skill',
            cluster: {
              version: AUTHOR_CLUSTER_DEFINITION_VERSION,
              id: 'skills:root-skill',
              links: [
                { collection: 'skills', id: 'linked-skill', relation: 'shared' },
                { collection: 'rules', id: 'linked-rule', relation: 'owned' },
                { collection: 'rules', id: 'dependency-only', relation: 'owned' },
                { collection: 'rules', id: 'rule-root', relation: 'related' },
                { collection: 'pieces', id: 'other-piece', relation: 'owned' },
              ],
            },
          },
          'linked-skill': {
            id: 'linked-skill',
            cluster: {
              version: AUTHOR_CLUSTER_DEFINITION_VERSION,
              id: 'skills:linked-skill',
              links: [{ collection: 'rules', id: 'linked-rule', relation: 'owned' }],
            },
          },
        },
        rules: {
          'linked-rule': {
            id: 'linked-rule',
            cluster: {
              version: AUTHOR_CLUSTER_DEFINITION_VERSION,
              id: 'rules:linked-rule',
              links: [{ collection: 'skills', id: 'root-skill', relation: 'shared' }],
            },
          },
          'rule-root': { id: 'rule-root' },
        },
      },
    )

    expect(result.definitions).toEqual([
      { id: 'skills:root-skill', skills: ['root-skill', 'linked-skill'], rules: ['linked-rule'] },
      { id: 'skills:linked-skill', skills: ['linked-skill'], rules: ['linked-rule'] },
      { id: 'rules:rule-root', skills: [], rules: ['rule-root'] },
    ])
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'uninstalled-cluster-link', memberId: 'dependency-only' }),
      expect.objectContaining({ code: 'unsupported-cluster-link', memberId: 'rule-root' }),
      expect.objectContaining({ code: 'unsupported-cluster-link', memberId: 'other-piece' }),
    ]))
  })

  it('does not traverse dependency metadata or adopt a player-scope link missing from the piece', () => {
    const catalog = fixtureCatalog()
    const piece = readJson('data/pieces/guldan.json')
    const result = planAuthorClusterInitialization(piece, catalog)
    const soulFracture = definitionById(result, 'skills:soul-fracture')

    expect(soulFracture).toEqual({ id: 'skills:soul-fracture', skills: ['soul-fracture'], rules: [] })
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'uninstalled-cluster-link',
        rootId: 'soul-fracture',
        memberId: 'rule-soul-fracture-player',
      }),
    ]))
  })

  it('maps all 45 normal piece fixtures to direct roots without inferred dependencies', () => {
    const catalog = fixtureCatalog()
    const manifest = readJson('data/pieces/manifest.json') as unknown as string[]
    const normalPieceIds = manifest.filter(id => !id.startsWith('pve-'))
    expect(normalPieceIds).toHaveLength(45)

    let definitionCount = 0
    let uninstalledLinkCount = 0
    for (const pieceId of normalPieceIds) {
      const piece = readJson(`data/pieces/${pieceId}.json`)
      const result = planAuthorClusterInitialization(piece, catalog)
      const skillIds = directIds(piece.skills, 'skill')
      const ruleIds = directIds(piece.rules, 'rule')
      const groupedRules = new Set(result.definitions.filter(item => item.id.startsWith('skills:')).flatMap(item => item.rules))
      const expectedIds = [...skillIds.map(id => `skills:${id}`), ...ruleIds.filter(id => !groupedRules.has(id)).map(id => `rules:${id}`)]

      expect(result.definitions.map(definition => definition.id)).toEqual(expectedIds)
      for (const definition of result.definitions) {
        expect(definition.skills.every(id => skillIds.includes(id))).toBe(true)
        expect(definition.rules.every(id => ruleIds.includes(id))).toBe(true)
      }
      definitionCount += result.definitions.length
      uninstalledLinkCount += result.diagnostics.filter(item => item.code === 'uninstalled-cluster-link').length
    }

    // Every installed skill remains a complete ability root. A rule already
    // belonging to one of those abilities no longer creates a second root.
    expect(definitionCount).toBeLessThan(196)
    expect(uninstalledLinkCount).toBe(1)
  })
})
