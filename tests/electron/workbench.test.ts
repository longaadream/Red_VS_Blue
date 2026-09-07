import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { CreativeWorkbench } from '../../electron-editor/workbench'

const roots: string[] = []
const input = { title: '吸血战士', brief: '新增普攻吸血效果', criteria: '按实际伤害回血，不超过上限' }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'rvb-workbench-'))
  roots.push(root)
  for (const collection of ['pieces', 'skills', 'cards', 'rules']) {
    mkdirSync(path.join(root, 'data', collection), { recursive: true })
    writeFileSync(path.join(root, 'data', collection, 'manifest.json'), JSON.stringify(collection === 'pieces' ? ['hero'] : collection === 'skills' ? ['drain'] : []))
  }
  const hero = path.join(root, 'data/pieces/hero.json')
  const skill = path.join(root, 'data/skills/drain.json')
  writeFileSync(hero, JSON.stringify({ id: 'hero', name: '战士', skills: [{ skillId: 'drain' }], stats: { maxHp: 100 } }))
  writeFileSync(skill, JSON.stringify({ id: 'drain', name: '吸血', amount: 3 }))
  const store = new CreativeWorkbench(root, root)
  return { root, hero, skill, store }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('persists a task baseline and shows actual field changes and related content after reopen', () => {
  const { root, skill, store } = fixture()
  const initial = store.create(input)
  expect(initial.changes).toEqual([])
  writeFileSync(skill, JSON.stringify({ id: 'drain', name: '吸血', amount: 6 }))
  const reopened = new CreativeWorkbench(root, root).inspect(initial.task.id)
  expect(reopened.changes).toHaveLength(1)
  expect(reopened.changes[0].fields).toContainEqual({ field: 'amount', before: 3, after: 6 })
  expect(reopened.changes[0].affected).toContain('data/pieces/hero.json')
  expect(reopened.task.baselineHash).toBe(initial.task.baselineHash)
})

it('invalidates old evidence after content changes and refuses stale candidates', () => {
  const { skill, store } = fixture()
  const initial = store.create(input)
  const checked = store.check(initial.task.id)
  expect(checked.check?.issues).toEqual([])
  writeFileSync(skill, JSON.stringify({ id: 'drain', amount: 9 }))
  const changed = store.inspect(initial.task.id)
  expect(changed.check).toBeNull()
  expect(changed.hasOlderChecks).toBe(true)
  expect(() => store.keep(initial.task.id, initial.contentHash)).toThrow('内容已改变')
  expect(() => store.keep(initial.task.id, changed.contentHash)).toThrow('请先通过')
})

it('reports invalid JSON and missing references without changing source bytes', () => {
  const { hero, skill, store } = fixture()
  const task = store.create(input).task
  writeFileSync(hero, '{"id":"hero","skills":[{"skillId":"missing"}]}')
  writeFileSync(skill, '{ broken')
  const state = store.check(task.id)
  expect(state.check?.issues.some(issue => issue.path === 'data/skills/drain.json' && issue.message.includes('JSON 解析失败'))).toBe(true)
  expect(state.check?.issues.some(issue => issue.message.includes('missing'))).toBe(true)
  expect(readFileSync(skill, 'utf8')).toBe('{ broken')
  expect(() => store.keep(task.id, state.contentHash)).toThrow('请先通过')
})

it('binds feedback and scenario context to the exact version without claiming execution', () => {
  const { root, store } = fixture()
  const state = store.create(input)
  store.scenario(state.task.id, { setup: '40/100 HP', action: 'attack', expected: 'heal 6', expectedHash: state.contentHash })
  const feedback = store.feedback(state.task.id, { message: '应按实际伤害回血', expectedHash: state.contentHash })
  expect(feedback.feedback[0].contentHash).toBe(state.contentHash)
  const context = JSON.parse(readFileSync(path.join(root, '.workbench/tasks', state.task.id, 'AI_CONTEXT.json'), 'utf8'))
  expect(context.scenarios[0].executed).toBe(false)
  expect(context.feedback[0].message).toBe('应按实际伤害回血')
  expect(context.feedback[0].scenarios[0].action).toBe('attack')
})

it('keeps candidate content immutable when subsequent AI edits continue', () => {
  const { root, skill, store } = fixture()
  const state = store.create(input)
  store.check(state.task.id)
  store.keep(state.task.id, state.contentHash)
  writeFileSync(skill, '{"id":"drain","amount":99}')
  const version = store.inspect(state.task.id).versions[0]
  expect(version.status).toBe('candidate-unverified')
  expect(version.published).toBe(false)
  const hash = (version.snapshot as Record<string, string>)['data/skills/drain.json']
  expect(JSON.parse(readFileSync(path.join(root, '.workbench/objects', hash), 'utf8')).amount).toBe(3)
})

it('rejects task traversal and content junctions before taking snapshots', () => {
  const { root, store } = fixture()
  expect(() => store.inspect('../outside')).toThrow('无效的任务编号')
  const outside = mkdtempSync(path.join(tmpdir(), 'rvb-workbench-outside-'))
  roots.push(outside)
  symlinkSync(outside, path.join(root, 'data', 'linked'), 'junction')
  expect(() => store.create(input)).toThrow('EDITOR_PATH_INVALID')
  expect(readdirSync(outside)).toEqual([])
})

it('detects corrupted baseline objects instead of presenting fabricated changes', () => {
  const { root, store, skill } = fixture()
  const state = store.create(input)
  const hash = state.task.baseline['data/skills/drain.json']
  writeFileSync(path.join(root, '.workbench/objects', hash), '{"id":"drain","amount":999}')
  writeFileSync(skill, '{"id":"drain","amount":8}')
  expect(() => store.inspect(state.task.id)).toThrow('快照校验失败')
})

it('refuses feedback if the displayed version changed outside the editor', () => {
  const { skill, store } = fixture()
  const state = store.create(input)
  writeFileSync(skill, '{"id":"drain","amount":100}')
  expect(() => store.feedback(state.task.id, { message: 'wrong', expectedHash: state.contentHash })).toThrow('内容已改变')
})

it.each([{ playerRules: ['missing-rule'] }, { playerRules: [{ ruleId: 'drain' }] }, { playerRules: 'not-an-array' }])('validates player rule references: %j', ({ playerRules }) => {
  const { hero, store } = fixture()
  const state = store.create(input)
  writeFileSync(hero, JSON.stringify({ id: 'hero', playerRules }))
  expect(store.check(state.task.id).check?.issues.some(issue => issue.severity === 'error' && issue.message.includes('playerRules'))).toBe(true)
})

it.each(['missing', [{ skillID: 'missing' }], [null]])('rejects malformed skill references: %j', skills => {
  const { hero, store } = fixture()
  const state = store.create(input)
  writeFileSync(hero, JSON.stringify({ id: 'hero', skills }))
  expect(store.check(state.task.id).check?.issues.some(issue => issue.severity === 'error')).toBe(true)
})

it('rejects mismatched cached evidence and repairs it on a fresh check', () => {
  const { root, store } = fixture()
  const state = store.create(input)
  const checked = store.check(state.task.id)
  const report = path.join(root, '.workbench/tasks', state.task.id, 'checks', state.contentHash + '.json')
  writeFileSync(report, JSON.stringify({ ...checked.check, contentHash: 'wrong' }))
  expect(store.inspect(state.task.id).check).toBeNull()
  expect(store.check(state.task.id).check?.contentHash).toBe(state.contentHash)
  writeFileSync(report, JSON.stringify({ contentHash: state.contentHash, issues: 'invalid' }))
  expect(store.inspect(state.task.id).check).toBeNull()
  expect(store.check(state.task.id).check?.issues).toEqual([])
})
