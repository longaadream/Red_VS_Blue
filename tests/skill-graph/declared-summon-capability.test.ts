import { describe, expect, it } from 'vitest'
import { parseDeclaredSummonCapability } from '../../lib/game/declared-summon-capability'
import { assertGameplayModuleDocument } from '../../lib/skill-graph/module-document'

const STORED_CAPABILITY = {
  version: 1,
  recipe: 'stored-or-declared-piece',
  maxSummons: 1,
  storageExtensionKey: 'storedSummon',
  ownerScopedStorageExtensionKey: 'storedSummonByPlayer',
  uniqueTemplateId: 'stored-template',
  fallback: {
    instanceIdPrefix: 'stored-',
    templateId: 'stored-template',
    name: 'Stored fallback',
    faction: 'red',
    maxHp: 10,
    attack: 2,
    defense: 1,
    moveRange: 3,
    skills: [{ skillId: 'stored-skill', level: 1, currentCooldown: 0 }],
  },
} as const

describe('declared summon capability document validation', () => {
  it('uses the same closed parser for runtime declarations and save validation', () => {
    const document = {
      id: 'declared-summon',
      kind: 'active',
      type: 'normal',
      summonCapability: STORED_CAPABILITY,
    }

    expect(() => parseDeclaredSummonCapability(STORED_CAPABILITY)).not.toThrow()
    expect(() => assertGameplayModuleDocument(document)).not.toThrow()

    const invalid = {
      ...document,
      summonCapability: {
        ...STORED_CAPABILITY,
        uniqueTemplateId: '',
      },
    }
    expect(() => parseDeclaredSummonCapability(invalid.summonCapability)).toThrow(/uniqueTemplateId/)
    expect(() => assertGameplayModuleDocument(invalid)).toThrow(/invalid summonCapability.*uniqueTemplateId/)
  })
})
