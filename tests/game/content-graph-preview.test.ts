import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { calculateSkillPreview, type SkillDefinition } from '../../lib/game/skills'
import type { PieceInstance } from '../../lib/game/piece'
import { applyContentGraph, assertContentGraphDocument } from '../../electron-editor/content-graph-document'
import { importContentGraph } from '../../electron-editor/content-graph-import'
import { makePiece } from '../helpers/minimal-state'

const baseline = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as {
  entries: Record<string, SkillDefinition>
}
const ids = Object.keys(baseline.entries).filter(id => id.startsWith('skills/')).filter(id => {
  const document = JSON.parse(readFileSync(`data/${id}.json`, 'utf8'))
  return document.contentGraphField === 'previewCode' || document.contentGraphEntries?.previewCode
}).map(id => id.slice('skills/'.length))
const candidates = Object.entries(baseline.entries).flatMap(([id, legacy]) => {
  if (!id.startsWith('skills/') || typeof legacy.previewCode !== 'string') return []
  try {
    const graph = importContentGraph(legacy.previewCode, 'preview')
    return [{id, legacy, current: applyContentGraph(legacy as unknown as Record<string, unknown>, graph, 'previewCode') as unknown as SkillDefinition}]
  } catch { return [] }
})

describe('supported preview corpus through the real host', () => {
  it('covers the frozen preview corpus', () => expect(candidates.length).toBeGreaterThanOrEqual(80))
  for (const {id, legacy, current} of candidates) it(id, () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const attack of [0, 1, 3, 8, 17]) for (const cooldown of [0, 1, 5]) {
        const piece = makePiece({instanceId: 'preview-piece', attack, currentHp: 3, maxHp: 12}) as unknown as PieceInstance
        expect(calculateSkillPreview(current, piece, cooldown)).toEqual(calculateSkillPreview(legacy, piece, cooldown))
      }
      expect(error).not.toHaveBeenCalled()
    } finally { error.mockRestore() }
  })
})

describe('graph-backed production skill previews', () => {
  for (const id of ids) it(`${id} preserves exact preview text and numbers`, () => {
    const current = JSON.parse(readFileSync(`data/skills/${id}.json`, 'utf8'))
    const legacy = baseline.entries[`skills/${id}`]
    assertContentGraphDocument(current)
    expect((current.contentGraphField === 'previewCode' ? current.contentGraph : current.contentGraphEntries.previewCode.graph).surface).toBe('preview')
    // Errors must fail, rather than allowing the runtime fallback to make a
    // broken graph appear equal to a static description.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const attack of [0, 1, 3, 8, 17]) for (const cooldown of [0, 1, 5]) {
        const piece = makePiece({instanceId: 'preview-piece', attack, currentHp: 3, maxHp: 12}) as unknown as PieceInstance
        expect(calculateSkillPreview(current, piece, cooldown)).toEqual(calculateSkillPreview(legacy, piece, cooldown))
      }
      expect(error).not.toHaveBeenCalled()
    } finally { error.mockRestore() }
  })
})
