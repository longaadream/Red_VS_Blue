import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createTrainingResources } from '../../electron-editor/training-resources'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'rvb-training-resources-')); roots.push(root)
  fs.mkdirSync(path.join(root, 'data/pages/js'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data/pieces'), { recursive: true })
  fs.writeFileSync(path.join(root, 'data/pages/battle.html'), 'trusted page')
  fs.writeFileSync(path.join(root, 'data/pages/js/game-engine.js'), 'trusted engine')
  fs.writeFileSync(path.join(root, 'data/pieces/old.json'), '{"attack":4}')
  const bytes = Buffer.from('{"attack":5,"skillCode":"return 1"}')
  const resource = createTrainingResources(root, { contentHash: 'a'.repeat(64), files: [{ path: 'data/pieces/new.json', bytes }, { path: 'js/game-engine.js', bytes: Buffer.from('untrusted engine') }] })
  return { root, bytes, resource }
}
it('freezes candidate bytes and refuses fallback to bundled data or author-supplied engine code', () => {
  const { resource, bytes } = fixture()
  bytes.fill(0)
  expect(JSON.parse(Buffer.from(resource('/data/pieces/new.json')!.bytes).toString()).attack).toBe(5)
  expect(resource('/data/pieces/old.json')).toBeNull()
  expect(Buffer.from(resource('/js/game-engine.js')!.bytes).toString()).toBe('trusted engine')
  expect(JSON.parse(Buffer.from(resource('/__editor-preview.json')!.bytes).toString()).contentHash).toBe('a'.repeat(64))
})
it.each(['/../package.json', '/%2e%2e/package.json', '/data/%2e%2e/pages/battle.html', '/data%5cpieces%5cnew.json', '/data/pieces/new.json%00', '/index.html', '/../../private.key', '/data/pages/hack.js'])('rejects non-preview path %s', input => {
  expect(fixture().resource(input)).toBeNull()
})
