import { execFileSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadAllSkillsById, loadCardById, loadRuleById } from '@/lib/game/skills'

type AuditFailure = Error & { status?: number; stdout?: string }

type CompatibilityAuditReport = {
  schemaVersion: number
  analysisVersion: number
  executionSurfaces: Record<string, unknown>
  unclassifiedFields: unknown[]
  triggerSkills: Array<{ file: string; path: string; skillId: string | null }>
  groups: Record<string, Array<{
    file: string
    executionFields: Array<{
      path: string
      surface?: string
      bindings: Array<{ status: string }>
    }>
  }>>
  syntaxErrors: unknown[]
  unsupportedUse: Record<string, unknown>
}

type DefinitionWithId = {
  id: string
  [key: string]: unknown
}

function runCompatibilityAudit(): { status: number; report: CompatibilityAuditReport } {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/audit-skillcode-compat.mjs'], { encoding: 'utf8' })
    return { status: 0, report: JSON.parse(stdout) as CompatibilityAuditReport }
  } catch (error) {
    const failure = error as AuditFailure
    return { status: failure.status ?? 1, report: JSON.parse(failure.stdout ?? '{}') as CompatibilityAuditReport }
  }
}

function readDefinitions(group: 'skills' | 'rules' | 'cards'): Array<{ file: string; definition: DefinitionWithId }> {
  return globSync(`data/${group}/**/*.json`).sort()
    .map(file => ({
      file: file.replace(/\\/g, '/'),
      definition: JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown },
    }))
    .filter((entry): entry is { file: string; definition: DefinitionWithId } => typeof entry.definition.id === 'string')
}

describe('RED-45 skillCode static compatibility audit', () => {
  it('classifies every executable field and every lexical free variable', () => {
    const { report } = runCompatibilityAudit()

    expect(report.schemaVersion).toBe(2)
    expect(report.analysisVersion).toBe(4)
    expect(Object.keys(report.executionSurfaces).sort()).toEqual([
      'cardCode', 'pendingEffectCode', 'ruleSkillCode', 'ruleTriggerSkill', 'skillCode',
    ])
    const loadedSkills = loadAllSkillsById()
    for (const reference of report.triggerSkills) {
      if (!reference.skillId) throw new Error(`Missing triggerSkill ID: ${reference.file}#${reference.path}`)
      expect(loadedSkills[reference.skillId], `${reference.file}#${reference.path}`).toBeDefined()
    }

    expect(report.unclassifiedFields).toEqual([])
    expect(report.triggerSkills).toHaveLength(27)
    for (const group of ['skills', 'rules', 'cards']) {
      for (const entry of report.groups[group]) {
        for (const field of entry.executionFields) {
          expect(field.surface, `${entry.file}#${field.path}`).toBeTruthy()
          expect(field.bindings.every(binding => ['supported', 'ambient', 'unsupported'].includes(binding.status))).toBe(true)
        }
      }
    }
  })

  it('keeps every skill code field syntactically valid', () => {
    const { status, report } = runCompatibilityAudit()

    expect(status).toBe(0)
    expect(report.syntaxErrors).toEqual([])
  })

  it('reports no unsupported free-variable use in the remaining data surfaces', () => {
    const { report } = runCompatibilityAudit()

    expect(report.unsupportedUse).toEqual({})
  })
})

describe('RED-45 data parse and production loader smoke', () => {
  it('parses every JSON definition and loads every skill, rule, and card', () => {
    const definitions = {
      skills: readDefinitions('skills'),
      rules: readDefinitions('rules'),
      cards: readDefinitions('cards'),
    }

    const loadedSkills = loadAllSkillsById()
    for (const { file, definition } of definitions.skills) {
      expect(loadedSkills[definition.id], file).toBeDefined()
    }
    for (const { file, definition } of definitions.rules) {
      expect(loadRuleById(definition.id, true), file).not.toBeNull()
    }
    for (const { file, definition } of definitions.cards) {
      expect(loadCardById(definition.id, true), file).not.toBeNull()
    }

    expect(definitions.skills.map(entry => entry.definition.id)).toHaveLength(113)
    expect(definitions.rules.map(entry => entry.definition.id)).toHaveLength(81)
    expect(definitions.cards.map(entry => entry.definition.id)).toHaveLength(16)
    expect(definitions.skills.every(entry => basename(entry.file, extname(entry.file)) === entry.definition.id)).toBe(true)
  })
})
