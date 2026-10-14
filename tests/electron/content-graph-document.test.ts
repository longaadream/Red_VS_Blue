import { describe, expect, it } from 'vitest'
import {
  CONTENT_GRAPH_COMPILER_VERSION,
  CONTENT_GRAPH_VERSION,
  type ContentGraph,
} from '../../electron-editor/content-graph'
import {
  applyContentGraph as applyDocumentGraph,
  applyContentGraphField,
  assertContentGraphArtifact as assertDocumentArtifact,
  assertContentGraphDocument,
} from '../../electron-editor/content-graph-document'

const literal = (value: string | number | boolean | null) => ({ kind: 'literal' as const, value })

function graph(surface: ContentGraph['surface'], value: string | number | boolean | null): ContentGraph {
  return {
    version: CONTENT_GRAPH_VERSION,
    surface,
    entry: 'return-1',
    nodes: [{ id: 'return-1', kind: 'return', value: literal(value) }],
  }
}

describe('content graph document artifacts', () => {
  it('keeps the primary code graph compatible and stores preview as an independent entry', () => {
    const original = {
      id: 'multi-entry-skill',
      name: '多入口技能',
      extension: { owner: 'future-tool', nested: { keep: true } },
    }
    const primary = applyContentGraphField(original, graph('skill', true), 'code')
    const document = applyContentGraphField(primary, graph('preview', 'preview'), 'previewCode')

    expect(document.contentGraphField).toBe('code')
    expect(document.contentGraph).toEqual(graph('skill', true))
    expect(document.code).toContain('function executeSkill')
    expect(document.previewCode).toContain('function calculatePreview')
    expect(document.contentGraphEntries).toMatchObject({
      previewCode: {
        graph: graph('preview', 'preview'),
        compilerVersion: CONTENT_GRAPH_COMPILER_VERSION,
      },
    })
    expect(document.extension).toEqual(original.extension)
    expect(() => assertContentGraphDocument(document)).not.toThrow()

    const withEntryExtension = {
      ...document,
      contentGraphEntries: {
        ...document.contentGraphEntries,
        previewCode: {
          ...document.contentGraphEntries?.previewCode,
          extension: { editor: 'keep-me' },
        },
      },
    }
    const updated = applyContentGraphField(withEntryExtension, graph('preview', 'updated'), 'previewCode')
    expect(updated.contentGraphEntries?.previewCode.extension).toEqual({ editor: 'keep-me' })
  })

  it('uses the rule compatibility field as the primary entry', () => {
    const document = applyContentGraphField({ extension: { keep: 'rule' } }, graph('rule', true))

    expect(document.contentGraphField).toBe('skillCode')
    expect(document.skillCode).toContain('return true')
    expect(document.contentGraphEntries).toBeUndefined()
    expect(() => assertContentGraphDocument(document)).not.toThrow()
    expect(() => assertDocumentArtifact(document)).not.toThrow()
    expect(applyDocumentGraph({ extension: { keep: 'alias' } }, graph('rule', true)).contentGraphField).toBe('skillCode')
  })

  it('rejects duplicate primary fields, illegal surfaces, old graphs, and tampering', () => {
    const primary = applyContentGraphField({ id: 'conflicts' }, graph('skill', true), 'code')
    const withPreview = applyContentGraphField(primary, graph('preview', 'preview'), 'previewCode')

    expect(() => applyContentGraphField({ skillGraph: { version: 'old' } }, graph('skill', true), 'code')).toThrow('旧 skillGraph')
    expect(() => assertContentGraphDocument({
      ...withPreview,
      contentGraphEntries: {
        ...withPreview.contentGraphEntries,
        code: {
          graph: graph('skill', true),
          compilerVersion: CONTENT_GRAPH_COMPILER_VERSION,
        },
      },
    })).toThrow('不得重复')
    expect(() => applyContentGraphField(primary, graph('skill', 'wrong surface'), 'previewCode')).toThrow('字段 previewCode 与 surface skill 不匹配')
    expect(() => assertContentGraphDocument({
      ...withPreview,
      previewCode: `${String(withPreview.previewCode)} `,
    })).toThrow('不一致')
    expect(() => assertContentGraphDocument({
      ...withPreview,
      contentGraphEntries: {
        ...withPreview.contentGraphEntries,
        previewCode: {
          ...withPreview.contentGraphEntries?.previewCode,
          compilerVersion: 'wrong-compiler',
        },
      },
    })).toThrow('compilerVersion')
    expect(() => assertContentGraphDocument({
      contentGraphEntries: withPreview.contentGraphEntries,
      previewCode: withPreview.previewCode,
    })).toThrow('requires a primary')
  })
})
