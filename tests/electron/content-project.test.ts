import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createContentProject, openContentProject, readDocumentSnapshot, writeDocumentSnapshot } from '../../electron-editor/content-project'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'rvb-content-project-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('creates a blank project without copying bundled content and reopens without populating it', () => {
  const root = fixture()
  const project = createContentProject(root, 'blank', path.join(root, 'missing-bundle'))
  expect(openContentProject(project)).toBe(project)
  expect(JSON.parse(readFileSync(path.join(project, 'data/pieces/manifest.json'), 'utf8'))).toEqual([])
  expect(readdirSync(path.join(project, 'data/pieces'))).toEqual(['manifest.json'])
})

it('copies official data and images into an independent content project', () => {
  const root = fixture()
  const bundle = path.join(root, 'bundle')
  mkdirSync(path.join(bundle, 'data/pieces'), { recursive: true })
  mkdirSync(path.join(bundle, 'public/images'), { recursive: true })
  writeFileSync(path.join(bundle, 'data/pieces/hero.json'), '{"id":"hero"}')
  writeFileSync(path.join(bundle, 'public/images/hero.svg'), '<svg/>')
  const project = createContentProject(root, 'official', bundle)
  writeFileSync(path.join(project, 'data/pieces/hero.json'), '{"id":"changed"}')
  expect(readFileSync(path.join(bundle, 'data/pieces/hero.json'), 'utf8')).toBe('{"id":"hero"}')
  expect(readFileSync(path.join(project, 'images/hero.svg'), 'utf8')).toBe('<svg/>')
})

it('refuses stale saves after an AI edit and preserves exact external bytes', () => {
  const file = path.join(fixture(), 'hero.json')
  writeFileSync(file, '{"hp":10}')
  const snapshot = readDocumentSnapshot(file)
  writeFileSync(file, '{ "hp": 20, "ai": true }\n')
  expect(() => writeDocumentSnapshot(file, { hp: 11 }, snapshot.revision)).toThrow('文件已被 AI')
  expect(readFileSync(file, 'utf8')).toBe('{ "hp": 20, "ai": true }\n')
})

it('returns the new revision after a successful save and does not leave temporary files', () => {
  const root = fixture()
  const file = path.join(root, 'hero.json')
  writeFileSync(file, '{"hp":10}')
  const before = readDocumentSnapshot(file)
  const saved = writeDocumentSnapshot(file, { hp: 12 }, before.revision)
  expect(saved.revision).toBe(readDocumentSnapshot(file).revision)
  expect(saved.revision).not.toBe(before.revision)
  expect(readdirSync(root)).toEqual(['hero.json'])
})

it('reports the malformed filename without modifying it', () => {
  const file = path.join(fixture(), 'broken.json')
  writeFileSync(file, '{ broken')
  expect(() => readDocumentSnapshot(file)).toThrow('broken.json')
  expect(readFileSync(file, 'utf8')).toBe('{ broken')
})

it('rejects unknown project formats rather than interpreting arbitrary folders', () => {
  const root = fixture()
  writeFileSync(path.join(root, 'rvb-content-project.json'), '{"schema":"unknown"}')
  expect(() => openContentProject(root)).toThrow('不支持的内容项目版本')
})
