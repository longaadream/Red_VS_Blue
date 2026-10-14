import { execFileSync } from 'node:child_process'
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { nonDiscoveryDefinitionReason } from '@/electron-editor/content-discovery-policy'
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
      bindings: Array<{ name: string; status: string }>
    }>
  }>>
  syntaxErrors: unknown[]
  unsupportedUse: Record<string, unknown>
}

type DefinitionWithId = {
  id: string
  [key: string]: unknown
}

type ContentGroup = 'skills' | 'rules' | 'cards'

// These are the independently registered non-discovery families in
// content-discovery-policy.ts. Do not derive this inventory from files that
// happen to exist: removing a template must fail the same smoke test.
const requiredNonDiscoveryIds: Readonly<Record<ContentGroup, readonly string[]>> = {
  skills: ['grimmjow-gran-rey-cero'],
  rules: ['rule-lucky-coin-gamestart'],
  cards: [
    'armor-attack-defense', 'armor-attack-heal', 'armor-attack-speed',
    'armor-defense-heal', 'armor-defense-speed', 'armor-heal-speed',
  ],
}

function readManifest(group: ContentGroup): string[] {
  const value = JSON.parse(readFileSync(`data/${group}/manifest.json`, 'utf8')) as unknown
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) {
    throw new Error(`Invalid ${group} manifest: expected an array of string IDs`)
  }
  return value
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort()
}

function isPveOnly(definition: DefinitionWithId): boolean {
  const availability = definition.availability
  if (typeof availability !== 'object' || availability === null || Array.isArray(availability)) return false
  const modes = (availability as { modes?: unknown }).modes
  return Array.isArray(modes) && modes.length > 0 && modes.every(mode => mode === 'pve')
}

function runCompatibilityAudit(cwd = process.cwd()): { status: number; report: CompatibilityAuditReport } {
  const script = join(process.cwd(), 'scripts', 'audit-skillcode-compat.mjs')
  try {
    const stdout = execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' })
    return { status: 0, report: JSON.parse(stdout) as CompatibilityAuditReport }
  } catch (error) {
    const failure = error as AuditFailure
    return { status: failure.status ?? 1, report: JSON.parse(failure.stdout ?? '{}') as CompatibilityAuditReport }
  }
}

function readDefinitions(group: ContentGroup): Array<{ file: string; definition: DefinitionWithId }> {
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
    expect(report.triggerSkills).toHaveLength(20)
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

  it('classifies compiler wrapper intrinsics as ambient host bindings', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-skillcode-audit-'))
    try {
      const skills = join(root, 'data', 'skills')
      mkdirSync(skills, { recursive: true })
      writeFileSync(join(skills, 'compiler-intrinsics.json'), JSON.stringify({
        id: 'compiler-intrinsics',
        code: 'function executeSkill(context) { return { value: Reflect.construct(Array, [arguments.length]), host: globalThis }; }',
      }), 'utf8')
      const { status, report } = runCompatibilityAudit(root)
      expect(status).toBe(0)
      const bindings = report.groups.skills
        .flatMap(entry => entry.executionFields)
        .flatMap(field => field.bindings)
      for (const name of ['Reflect', 'globalThis', 'arguments']) {
        expect(bindings.some(binding => binding.name === name && binding.status === 'ambient')).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
      expect(loadedSkills[definition.id]?.id, file).toBe(definition.id)
    }
    expect(sortedIds(Object.keys(loadedSkills)), 'skill loader IDs must equal every raw skill definition ID')
      .toEqual(sortedIds(definitions.skills.map(entry => entry.definition.id)))
    for (const { file, definition } of definitions.rules) {
      const loadedRule = loadRuleById(definition.id, true)
      expect(loadedRule, file).not.toBeNull()
      expect(loadedRule?.id, file).toBe(definition.id)
    }
    for (const { file, definition } of definitions.cards) {
      const availability = definition.availability as { status?: unknown } | undefined
      const loadedCard = loadCardById(definition.id, true)
      if (availability?.status === 'draft') expect(loadedCard, file).toBeNull()
      else {
        expect(loadedCard, file).not.toBeNull()
        expect(loadedCard?.id, file).toBe(definition.id)
      }
    }

    for (const group of ['skills', 'rules', 'cards'] as const) {
      const entries = definitions[group]
      const manifestIds = readManifest(group)
      const manifestSet = new Set(manifestIds)
      const rawIds = entries.map(entry => entry.definition.id)
      const rawSet = new Set(rawIds)
      const nonDiscoveryEntries = entries.filter(entry => nonDiscoveryDefinitionReason(entry.file))
      const nonDiscoveryIds = nonDiscoveryEntries.map(entry => entry.definition.id)
      const unregisteredEntries = entries.filter(entry => !manifestSet.has(entry.definition.id))
      const pveOnlyIds = entries.filter(entry => isPveOnly(entry.definition)).map(entry => entry.definition.id)
      const manifestPveOnlyIds = entries
        .filter(entry => manifestSet.has(entry.definition.id) && isPveOnly(entry.definition))
        .map(entry => entry.definition.id)
      const ordinaryManifestIds = manifestIds.filter(id => !pveOnlyIds.includes(id))
      const ordinaryRawIds = entries
        .filter(entry => manifestSet.has(entry.definition.id) && !isPveOnly(entry.definition))
        .map(entry => entry.definition.id)

      expect(sortedIds(nonDiscoveryEntries.map(entry => entry.file)), `${group} registered non-discovery definitions must all exist`)
        .toEqual(sortedIds(requiredNonDiscoveryIds[group].map(id => `data/${group}/${id}.json`)))
      expect(manifestIds, `${group} manifest must not contain duplicate IDs`).toHaveLength(manifestSet.size)
      expect(rawIds, `${group} raw definitions must not contain duplicate IDs`).toHaveLength(rawSet.size)
      expect(sortedIds(rawIds), `${group} raw IDs must be exactly manifest IDs plus registered non-discovery IDs`)
        .toEqual(sortedIds([...manifestSet, ...nonDiscoveryIds]))
      expect(sortedIds(unregisteredEntries.map(entry => entry.definition.id)), `${group} unregistered raw IDs`)
        .toEqual(sortedIds(nonDiscoveryIds))
      expect(nonDiscoveryIds.every(id => !manifestSet.has(id)), `${group} non-discovery IDs must stay out of the manifest`)
        .toBe(true)
      expect(sortedIds(pveOnlyIds), `${group} PVE-only IDs must come from the manifest authority`)
        .toEqual(sortedIds(manifestPveOnlyIds))
      expect(sortedIds(ordinaryRawIds), `${group} ordinary IDs must equal the non-PVE manifest set`)
        .toEqual(sortedIds(ordinaryManifestIds))
    }

    expect(definitions.skills.every(entry => basename(entry.file, extname(entry.file)) === entry.definition.id)).toBe(true)
  })
})
