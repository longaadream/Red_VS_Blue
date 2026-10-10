import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTENT_GRAPH_VERSION,
  applyContentGraph,
  assertContentGraphArtifact,
  type ContentGraph,
} from '../../electron-editor/content-graph'
import { readDocumentSnapshot, writeDocumentSnapshot } from '../../electron-editor/content-project'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'rvb-content-graph-artifact-'))
  roots.push(root)
  return path.join(root, 'skill.json')
}

function graph(): ContentGraph {
  return {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'bind-1',
    nodes: [
      { id: 'bind-1', kind: 'bind', name: 'value', expr: { kind: 'literal', value: 1 }, next: 'return-1' },
      { id: 'return-1', kind: 'return' },
    ],
  }
}

function artifact() {
  return applyContentGraph({
    id: 'graph-artifact',
    name: '图产物',
    extension: { owner: 'future-tool', nested: { keep: true } },
  }, graph())
}

describe('content graph editor save boundary', () => {
  it('rejects a tampered generated field without changing the file', () => {
    const file = fixture()
    const original = artifact()
    writeFileSync(file, JSON.stringify(original, null, 2) + '\n')
    const snapshot = readDocumentSnapshot(file)
    const tampered = { ...original, code: `${String(original.code)}\n// stale` }

    expect(() => writeDocumentSnapshot(file, tampered, snapshot.revision)).toThrow('artifact 字段 code')
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(original, null, 2) + '\n')
  })

  it('saves a valid regenerated artifact and preserves unknown fields', () => {
    const file = fixture()
    const original = artifact()
    writeFileSync(file, JSON.stringify(original, null, 2) + '\n')
    const snapshot = readDocumentSnapshot(file)
    const next = { ...original, name: '更新后的图产物' }

    expect(() => assertContentGraphArtifact(next)).not.toThrow()
    const result = writeDocumentSnapshot(file, next, snapshot.revision)
    expect(result.revision).toBe(readDocumentSnapshot(file).revision)
    expect(readDocumentSnapshot(file).value).toMatchObject({
      name: '更新后的图产物',
      extension: { owner: 'future-tool', nested: { keep: true } },
      contentGraph: graph(),
    })
  })
})
