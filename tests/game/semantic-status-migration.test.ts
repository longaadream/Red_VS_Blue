import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { migrateStatusSkills, STATUS_SKILL_RECIPES } from '@/scripts/migrate-semantic-status-skills'
import { migrateStatusEvents, STATUS_EVENT_RECIPES } from '@/scripts/migrate-semantic-status-events'

const fixtureText = readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')
const fixture = JSON.parse(fixtureText).entries
for (const [group, recipes, migrate, field] of [
  ['skills', STATUS_SKILL_RECIPES, migrateStatusSkills, 'code'],
  ['rules', STATUS_EVENT_RECIPES, migrateStatusEvents, 'skillCode'],
] as const) describe('status migration ownership: ' + group, () => {
  const makeFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-status-migrate-'))
    mkdirSync(join(root, 'data', group), { recursive: true })
    mkdirSync(join(root, 'tests/game/fixtures'), { recursive: true })
    writeFileSync(join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), fixtureText)
    for (const id of Object.keys(recipes)) writeFileSync(join(root, 'data', group, id + '.json'), JSON.stringify(fixture[group + '/' + id]))
    return root
  }
  it('is idempotent and preserves author metadata exactly', () => {
    const root = makeFixture()
    try {
      expect(migrate(root, true)).toHaveLength(Object.keys(recipes).length)
      const snapshots = Object.keys(recipes).map(id => readFileSync(join(root, 'data', group, id + '.json'), 'utf8'))
      expect(migrate(root, true)).toEqual([])
      expect(Object.keys(recipes).map(id => readFileSync(join(root, 'data', group, id + '.json'), 'utf8'))).toEqual(snapshots)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('preflights every entry before writing and refuses a custom executable', () => {
    const root = makeFixture()
    try {
      const ids = Object.keys(recipes), last = ids[ids.length - 1], file = join(root, 'data', group, last + '.json')
      const modified = JSON.parse(readFileSync(file, 'utf8')); modified[field] = field === 'code' ? 'function executeSkill(){return {success:false,message:"custom"};}' : 'return {success:false,message:"custom"};'
      writeFileSync(file, JSON.stringify(modified))
      const before = ids.map(id => readFileSync(join(root, 'data', group, id + '.json'), 'utf8'))
      expect(() => migrate(root, true)).toThrow('author executable differs')
      expect(ids.map(id => readFileSync(join(root, 'data', group, id + '.json'), 'utf8'))).toEqual(before)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('rejects stale generated code on an already migrated entry', () => {
    const root = makeFixture()
    try {
      migrate(root, true)
      const id = Object.keys(recipes)[0], file = join(root, 'data', group, id + '.json'), modified = JSON.parse(readFileSync(file, 'utf8'))
      modified[field] += ' // edited'
      writeFileSync(file, JSON.stringify(modified))
      expect(() => migrate(root, true)).toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
