import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertContentGraphArtifact } from '../../electron-editor/content-graph-document'
import { assertSkillClusterMetadata } from '../../lib/skill-graph/module-cluster'

type Document = Record<string, unknown> & {
  contentGraph?: unknown
  contentGraphField?: string
  contentGraphEntries?: Record<string, unknown>
  gameplayModules?: { entries: Record<string, unknown> }
}
const baseline = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as {entries:Record<string, Document>}
const bookkeeping = new Set(['contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
const documents = Object.entries(baseline.entries).map(([id, original]) => ({
  id, original, current: JSON.parse(readFileSync(`data/${id}.json`, 'utf8')) as Document,
})).filter(({current}) => current.contentGraph || current.gameplayModules)

describe('production content graphs retain the frozen content contract', () => {
  it('checks actual migrated documents', () => expect(documents.length).toBeGreaterThanOrEqual(12))
  for (const {id, original, current} of documents) it(id, () => {
    expect(() => assertContentGraphArtifact(current)).not.toThrow()
    if (current.cluster !== undefined) {
      expect(id.startsWith('skills/')).toBe(true)
      expect(() => assertSkillClusterMetadata(current)).not.toThrow()
      expect(current.cluster).toMatchObject({ id: id.replace('/', ':') })
    }
    const generated = new Set([current.contentGraphField, ...Object.keys(current.contentGraphEntries ?? {}), ...Object.keys(current.gameplayModules?.entries ?? {})].filter(Boolean))
    const project = (value:Document) => Object.fromEntries(Object.entries(value).filter(([key]) => !bookkeeping.has(key) && !generated.has(key)))
    // Includes descriptions, targeting, costs, presentation configuration and
    // unknown fields. Only validated authoring metadata and generated source differ.
    const expected = project(original)
    // Explicit user-approved correction: each passenger teleports independently.
    // Keep the frozen source intact and assert the entire approved wording.
    if (id === 'skills/tails-twin-flight') expected.description = '选择其他友军（4）。在自身7格内选择2个上下左右相邻的空地或掩体，分别标记为双方落点。标记格可被进入。双方获得免疫[2]与不可操作[2]。此后的第2个己方回合结束时分别传送至标记格。落点被占或无法落脚时，仅取消对应棋子的传送。结束飞行状态。'
    expect(project(current)).toEqual(expected)
    for (const field of generated) expect(typeof original[field as string]).toBe('string')
  })
})
