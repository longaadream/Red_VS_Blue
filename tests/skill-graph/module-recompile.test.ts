import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph, createGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { recompileGameplayDocuments } from '@/scripts/recompile-gameplay-modules'

const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'rvb-module-recompile-'))
  roots.push(root)
  for (const group of ['pieces', 'skills', 'rules', 'cards']) fs.mkdirSync(path.join(root, 'data', group), { recursive: true })
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('module compiler artifact refresh', () => {
  it('preserves author graphs and unrelated metadata and is idempotent', () => {
    const root = fixture()
    const document = applyGameplayModuleGraph({ id: 'probe', extension: { future: [1, { value: true }] } }, createGameplayModuleGraph('skill'))
    const file = path.join(root, 'data/skills/probe.json')
    fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n')
    const original = fs.readFileSync(file, 'utf8')
    expect(recompileGameplayDocuments(root)).toEqual({ documents: 1, entries: 1, changed: [] })
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(recompileGameplayDocuments(root, true).changed).toEqual([])
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(document)
  })

  it('refuses modified executable source before writing any files', () => {
    const root = fixture()
    const valid = applyGameplayModuleGraph({ id: 'a' }, createGameplayModuleGraph('skill'))
    const invalid = { ...valid, id: 'z', code: 'function executeSkill() { return {success: true}; }' }
    const first = path.join(root, 'data/skills/a.json')
    const last = path.join(root, 'data/skills/z.json')
    fs.writeFileSync(first, JSON.stringify(valid))
    fs.writeFileSync(last, JSON.stringify(invalid))
    const before = fs.readFileSync(first, 'utf8')
    expect(() => recompileGameplayDocuments(root, true)).toThrow()
    expect(fs.readFileSync(first, 'utf8')).toBe(before)
    expect(JSON.parse(fs.readFileSync(last, 'utf8'))).toEqual(invalid)
  })
})
