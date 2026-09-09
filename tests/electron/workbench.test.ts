import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
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

function selection(state: ReturnType<CreativeWorkbench['inspect']>, paths: string[]) {
  return { paths, expectedHash: state.contentHash, expectedAcceptedHash: state.acceptedHash }
}

it('accepts an image independently, leaves skill drafts untouched, and reverts only the selected skill', () => {
  const { root, skill, store } = fixture()
  mkdirSync(path.join(root, 'images'))
  const image = path.join(root, 'images/hero.png')
  writeFileSync(image, 'old image')
  const initial = store.create(input)
  writeFileSync(image, 'new image'); writeFileSync(skill, '{"id":"drain","amount":9}')
  const modified = store.inspect(initial.task.id)
  const accepted = store.accept(initial.task.id, selection(modified, ['images/hero.png']))
  expect(accepted.changes.map(change => change.path)).toEqual(['data/skills/drain.json'])
  expect(accepted.versions[0].status).toBe('accepted')
  expect(accepted.versions[0].published).toBe(false)
  expect(readFileSync(skill, 'utf8')).toContain('9')
  const reverted = store.revert(initial.task.id, selection(accepted, ['data/skills/drain.json']))
  expect(reverted.changes).toEqual([])
  expect(JSON.parse(readFileSync(skill, 'utf8')).amount).toBe(3)
  expect(readFileSync(image, 'utf8')).toBe('new image')
  expect(readdirSync(path.join(root, '.workbench/transactions'))).toHaveLength(1)
})

it('refuses accepting only a reference whose required new object was not selected', () => {
  const { root, hero, store } = fixture()
  const initial = store.create(input)
  writeFileSync(hero, '{"id":"hero","skills":["new-skill"]}')
  writeFileSync(path.join(root, 'data/skills/new-skill.json'), '{"id":"new-skill"}')
  writeFileSync(path.join(root, 'data/skills/manifest.json'), '["drain","new-skill"]')
  const current = store.inspect(initial.task.id)
  expect(() => store.accept(initial.task.id, selection(current, ['data/pieces/hero.json']))).toThrow('一并选择依赖')
  expect(store.inspect(initial.task.id).acceptedHash).toBe(initial.acceptedHash)
  expect(store.accept(initial.task.id, selection(current, current.changes.map(change => change.path))).changes).toEqual([])
})

it('refuses stale accept/revert requests without touching newer external edits', () => {
  const { store, skill } = fixture()
  const initial = store.create(input)
  writeFileSync(skill, '{"id":"drain","amount":7}')
  const seen = store.inspect(initial.task.id)
  writeFileSync(skill, '{"id":"drain","amount":10}')
  for (const action of ['accept', 'revert'] as const) expect(() => store[action](initial.task.id, selection(seen, ['data/skills/drain.json']))).toThrow('内容或已接受版本已改变')
  expect(JSON.parse(readFileSync(skill, 'utf8')).amount).toBe(10)
})

it('accepts one valid file while an unrelated draft remains invalid', () => {
  const { store, skill, hero } = fixture()
  const initial = store.create(input)
  writeFileSync(skill, '{ invalid')
  writeFileSync(hero, '{"id":"hero","skills":["drain"],"stats":{"maxHp":200}}')
  const current = store.inspect(initial.task.id)
  const result = store.accept(initial.task.id, selection(current, ['data/pieces/hero.json']))
  expect(result.changes.map(change => change.path)).toEqual(['data/skills/drain.json'])
  expect(readFileSync(skill, 'utf8')).toBe('{ invalid')
})

it('materializes accepted bytes instead of later draft edits and binds the requested identity', () => {
  const { root, store, skill } = fixture()
  const initial = store.create(input)
  writeFileSync(skill, '{"id":"drain","amount":7}')
  const current = store.inspect(initial.task.id)
  const accepted = store.accept(initial.task.id, selection(current, ['data/skills/drain.json']))
  writeFileSync(skill, '{"id":"drain","amount":20}')
  const staged = store.materializeAccepted(initial.task.id, accepted.acceptedHash)
  expect(JSON.parse(readFileSync(path.join(root, staged.source, 'data/skills/drain.json'), 'utf8')).amount).toBe(7)
  expect(() => store.materializeAccepted(initial.task.id, initial.acceptedHash)).toThrow('已接受版本发生变化')
})

it('does not revert an accepted change when another task inspects the shared workspace', () => {
  const { store, skill } = fixture()
  const one = store.create(input)
  const two = store.create({ ...input, title: '另一任务' })
  writeFileSync(skill, '{"id":"drain","amount":7}')
  const current = store.inspect(one.task.id)
  store.accept(one.task.id, selection(current, ['data/skills/drain.json']))
  expect(store.inspect(two.task.id).changes).toEqual([])
  expect(() => store.accept(two.task.id, selection(current, ['data/skills/drain.json']))).toThrow('已接受版本已改变')
})

it('does not implicitly accept older drafts when a new task starts after external edits', () => {
  const { store, root, skill } = fixture()
  mkdirSync(path.join(root, 'images'))
  writeFileSync(path.join(root, 'images/hero.png'), 'old')
  const first = store.create(input)
  writeFileSync(skill, '{"id":"drain","amount":100}')
  const second = store.create({ ...input, title: '只换图片' })
  writeFileSync(path.join(root, 'images/hero.png'), 'new')
  const current = store.inspect(second.task.id)
  expect(current.acceptedHash).toBe(first.acceptedHash)
  const accepted = store.accept(second.task.id, selection(current, ['images/hero.png']))
  const source = store.materializeAccepted(second.task.id, accepted.acceptedHash)
  expect(JSON.parse(readFileSync(path.join(root, source.source, 'data/skills/drain.json'), 'utf8')).amount).toBe(3)
  expect(accepted.changes.map(change => change.path)).toEqual(['data/skills/drain.json'])
})

it.each(['../main.ts', 'electron-client/main.ts', 'data/../main.ts', 'images/../../main.ts', 'data/x.js'])('rejects non-content selection %s', relative => {
  const { store } = fixture()
  const initial = store.create(input)
  expect(() => store.accept(initial.task.id, selection(initial, [relative]))).toThrow()
})

it('keeps a new external file when restoring a deleted file would overwrite it', () => {
  const { root, store, skill } = fixture()
  const initial = store.create(input)
  const moved = path.join(root, 'data/skills/moved.json')
  writeFileSync(moved, '{"id":"moved"}')
  // A stale request is refused before any delete/restore operation.
  const current = store.inspect(initial.task.id)
  writeFileSync(skill, '{"id":"drain","amount":99}')
  expect(() => store.revert(initial.task.id, selection(current, ['data/skills/moved.json']))).toThrow('内容或已接受版本已改变')
  expect(existsSync(moved)).toBe(true)
})

it('exports AI instructions prohibiting process and engine changes without binding to a provider', () => {
  const { store, root } = fixture()
  const state = store.create(input)
  store.handoff(state.task.id)
  const instructions = readFileSync(path.join(root, '.workbench/tasks', state.task.id, 'AI_TASK.md'), 'utf8')
  expect(instructions).toContain('禁止修改游戏及编辑器主进程')
  expect(instructions).toContain('本任务无需建立 Git 分支')
  expect(instructions).toContain('不得自行接受或发布内容')
})

it('accepts a JSON change while an uppercase image extension remains in the baseline', () => {
  const { root, store, skill } = fixture()
  mkdirSync(path.join(root, 'images'))
  writeFileSync(path.join(root, 'images/Hero.PNG'), 'image')
  const initial = store.create(input)
  writeFileSync(skill, '{"id":"drain","amount":4}')
  const current = store.inspect(initial.task.id)
  const accepted = store.accept(initial.task.id, selection(current, ['data/skills/drain.json']))
  expect(store.materializeAccepted(initial.task.id, accepted.acceptedHash).snapshot['images/Hero.PNG']).toBeTruthy()
  writeFileSync(path.join(root, 'images/Hero.PNG'), 'new image')
  const imageChange = store.inspect(initial.task.id)
  expect(store.accept(initial.task.id, selection(imageChange, ['images/Hero.PNG'])).changes).toEqual([])
})
