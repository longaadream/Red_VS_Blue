import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { listAuthorDrafts, saveAuthorDraft, removeAuthorDraft } from '../../electron-editor/author-drafts'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'rvb-author-draft-'))
  roots.push(root)
  mkdirSync(path.join(root, 'data/skills'), { recursive: true })
  writeFileSync(path.join(root, 'data/skills/example.json'), '{"id":"example","name":"有效技能"}\n')
  return root
}
const payload = () => ({ saved: { id: 'example', name: '有效技能' }, draft: { id: 'example', name: '未完成技能', unfinished: true }, serialized: '{ 未完成的输入', baseRevision: 'original-revision', pendingCreate: false })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('persists incomplete source and object without overwriting runnable content', () => {
  const root = fixture(), file = path.join(root, 'data/skills/example.json')
  const before = readFileSync(file, 'utf8')
  const saved = saveAuthorDraft(root, 'skills', 'example', payload(), null)
  expect(listAuthorDrafts(root, 'skills')).toEqual([{ id: 'example', revision: saved.revision, ...payload() }])
  expect(readFileSync(file, 'utf8')).toBe(before)
})
it('detects competing editors and requires the matching draft revision to remove', () => {
  const root = fixture(), first = saveAuthorDraft(root, 'skills', 'example', payload(), null)
  const updated = { ...payload(), serialized: '第二个窗口的修改' }
  const second = saveAuthorDraft(root, 'skills', 'example', updated, first.revision)
  expect(() => saveAuthorDraft(root, 'skills', 'example', payload(), first.revision)).toThrow('草稿已被其他窗口修改')
  expect(() => removeAuthorDraft(root, 'skills', 'example', first.revision)).toThrow('草稿已被其他窗口修改')
  expect(listAuthorDrafts(root, 'skills')[0].serialized).toBe(updated.serialized)
  removeAuthorDraft(root, 'skills', 'example', second.revision)
  expect(listAuthorDrafts(root, 'skills')).toEqual([])
})
it('keeps a new unsaved document recoverable and isolated by project and collection', () => {
  const root = fixture(), other = fixture()
  saveAuthorDraft(root, 'skills', 'new-example', { ...payload(), pendingCreate: true, baseRevision: null }, null)
  expect(listAuthorDrafts(root, 'skills')[0].pendingCreate).toBe(true)
  expect(listAuthorDrafts(root, 'cards')).toEqual([])
  expect(listAuthorDrafts(other, 'skills')).toEqual([])
})
it('rejects traversal and malformed metadata without writing content', () => {
  const root = fixture()
  expect(() => saveAuthorDraft(root, '../data', 'example', payload(), null)).toThrow()
  expect(() => saveAuthorDraft(root, 'skills', '../example', payload(), null)).toThrow()
  expect(() => saveAuthorDraft(root, 'skills', 'example', { ...payload(), serialized: 42 }, null)).toThrow()
  expect(listAuthorDrafts(root, 'skills')).toEqual([])
})
it('preserves unapplied expression text separately from runnable document fields', () => {
  const root = fixture()
  const editorState = { 'skills:example:': { expressions: [['draft:damage:value', '当前棋子.攻击力 * (']] } }
  saveAuthorDraft(root, 'skills', 'example', { ...payload(), editorState }, null)
  const restored = listAuthorDrafts(root, 'skills')[0]
  expect(restored.editorState).toEqual(editorState)
  expect(restored.draft).toEqual(payload().draft)
  expect(readFileSync(path.join(root, 'data/skills/example.json'), 'utf8')).not.toContain('editorState')
})
