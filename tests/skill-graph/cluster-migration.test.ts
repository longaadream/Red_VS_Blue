import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadClusterCatalog, migrateSkillClusters, VERIFIED_PASSIVE_LINKS } from '../../scripts/migrate-skill-clusters'
import { buildSkillCluster } from '../../lib/skill-graph/module-cluster'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rvb-cluster-migration-'))
  roots.push(root)
  for (const group of ['skills', 'rules', 'pieces', 'cards']) {
    mkdirSync(join(root, 'data', group), { recursive: true })
    writeFileSync(join(root, 'data', group, 'manifest.json'), '[]')
  }
  const skills = [
    { id: 'active', name: '主动', kind: 'active', code: 'function executeSkill(){return {success:true}}', extension: { nested: [1, 2] } },
    { id: 'passive', name: '被动', kind: 'passive', passiveTraits: ['opening-vanguard'] },
    { id: 'pve-only', name: '冒险', availability: { modes: ['pve'] } },
  ]
  writeFileSync(join(root, 'data/skills/manifest.json'), JSON.stringify(skills.map(item => item.id)))
  for (const skill of skills) writeFileSync(join(root, `data/skills/${skill.id}.json`), JSON.stringify(skill))
  writeFileSync(join(root, 'data/skills/unlisted.json'), '{"id":"unlisted"}')
  return { root, skills }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Cluster metadata migration', () => {
  it('covers the complete ordinary production roster and preserves all reviewed passive associations', () => {
    const { catalog } = loadClusterCatalog(process.cwd())
    const before = JSON.stringify(catalog)
    const report = migrateSkillClusters(process.cwd(), false)
    expect(report.summary).toEqual({ skills: 174, passiveSkills: 53, pieceAbilityGroups: 45, changed: 0 })
    expect(report.clusters.flatMap(cluster => cluster.diagnostics.filter(item => item.severity === 'error'))).toEqual([])
    for (const [id, mapping] of Object.entries(VERIFIED_PASSIVE_LINKS)) {
      const cluster = buildSkillCluster(catalog, { collection: 'skills', id })
      for (const ruleId of mapping.ruleIds) {
        expect(cluster.members.rules.find(rule => rule.id === ruleId)?.relation).toBe(mapping.shared?.includes(ruleId) ? 'shared' : 'owned')
      }
    }
    expect(JSON.stringify(catalog)).toBe(before)
  })
  it('covers active and passive skills without changing executable/unknown fields or excluded content', () => {
    const { root, skills } = fixture()
    const before = readFileSync(join(root, 'data/skills/pve-only.json'), 'utf8')
    const report = migrateSkillClusters(root, true)
    expect(report.summary.skills).toBe(2)
    expect(report.summary.passiveSkills).toBe(1)
    expect(report.unmanifested).toEqual(['skills/unlisted'])
    expect(report.completeSemanticMigration).toBe(false)
    for (const original of skills.slice(0, 2)) {
      const next = JSON.parse(readFileSync(join(root, `data/skills/${original.id}.json`), 'utf8'))
      expect(next.cluster.id).toBe(`skills:${original.id}`)
      delete next.cluster
      expect(next).toEqual(original)
    }
    expect(readFileSync(join(root, 'data/skills/pve-only.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(root, 'data/skills/unlisted.json'), 'utf8')).toBe('{"id":"unlisted"}')
  })
  it('is idempotent and retains user-authored Cluster metadata', () => {
    const { root } = fixture()
    migrateSkillClusters(root, true)
    const file = join(root, 'data/skills/active.json')
    const draft = JSON.parse(readFileSync(file, 'utf8'))
    draft.cluster.extension = { note: 'keep' }
    writeFileSync(file, JSON.stringify(draft))
    expect(migrateSkillClusters(root, true).summary.changed).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(draft)
  })
  it('preflights every source before writing and rejects incompatible existing metadata', () => {
    const { root } = fixture()
    const first = join(root, 'data/skills/active.json')
    const before = readFileSync(first, 'utf8')
    const broken = join(root, 'data/skills/passive.json')
    const draft = JSON.parse(readFileSync(broken, 'utf8'))
    draft.cluster = { version: 'future', id: 'skills:passive', links: [] }
    writeFileSync(broken, JSON.stringify(draft))
    expect(() => migrateSkillClusters(root, true)).toThrow('Unsupported Cluster identity')
    expect(readFileSync(first, 'utf8')).toBe(before)
  })
})
