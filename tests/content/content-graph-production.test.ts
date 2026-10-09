import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertContentGraphArtifact } from '../../electron-editor/content-graph-document'

type Document = Record<string, unknown> & {
  contentGraph?: unknown
  contentGraphField?: string
  contentGraphEntries?: Record<string, unknown>
}
const baseline = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as {entries:Record<string, Document>}
const bookkeeping = new Set(['contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries'])
const documents = Object.entries(baseline.entries).map(([id, original]) => ({
  id, original, current: JSON.parse(readFileSync(`data/${id}.json`, 'utf8')) as Document,
})).filter(({current}) => current.contentGraph)

describe('production content graphs retain the frozen content contract', () => {
  it('checks actual migrated documents', () => expect(documents.length).toBeGreaterThanOrEqual(12))
  for (const {id, original, current} of documents) it(id, () => {
    expect(() => assertContentGraphArtifact(current)).not.toThrow()
    const generated = new Set([current.contentGraphField, ...Object.keys(current.contentGraphEntries ?? {})])
    const project = (value:Document) => Object.fromEntries(Object.entries(value).filter(([key]) => !bookkeeping.has(key) && !generated.has(key)))
    // Includes descriptions, targeting, costs, presentation configuration and
    // unknown fields. Only validated graph artifacts and generated source differ.
    expect(project(current)).toEqual(project(original))
    for (const field of generated) expect(typeof original[field as string]).toBe('string')
  })
})
