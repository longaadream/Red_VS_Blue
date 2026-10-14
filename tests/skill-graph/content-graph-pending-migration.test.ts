import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildPendingContentMigration } from '../../scripts/migrate-pending-content-graphs'
import { applyContentGraph, CONTENT_GRAPH_VERSION } from '../../electron-editor/content-graph-document'
import { importContentGraph } from '../../electron-editor/content-graph-import'

const id = 'skills/turalyon-grand-crusade'
const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json','utf8'))
const original = () => structuredClone(fixture.entries[id])

describe('pending migration conflict protection', () => {
  it('preserves extension fields and permits an exact repeat of its own migration', () => {
    const current = {...original(),futureExtension:{enabled:true}}
    const built = buildPendingContentMigration(id,current)
    expect(built.document.futureExtension).toEqual({enabled:true})
    expect(built.sourcePairs).toHaveLength(2)
    expect(buildPendingContentMigration(id,built.document).document).toEqual(built.document)
    const withPreview = applyContentGraph(built.document, importContentGraph(original().previewCode, 'preview'), 'previewCode')
    expect(buildPendingContentMigration(id,withPreview).document).toEqual(withPreview)
  })
  it('rejects changed source, metadata and a valid hand-edited graph', () => {
    expect(() => buildPendingContentMigration(id,{...original(),code:'function executeSkill(context){return 1;}'})).toThrow(/source differs/)
    expect(() => buildPendingContentMigration(id,{...original(),description:'changed'})).toThrow(/baseline field changed: description/)
    const edited = applyContentGraph(original(),{version:CONTENT_GRAPH_VERSION,surface:'skill',entry:'return',nodes:[{id:'return',kind:'return',value:{kind:'literal',value:'user change'}}]},'code')
    expect(() => buildPendingContentMigration(id,edited)).toThrow(/existing graph differs/)
  })
  it('rejects arbitrary paths and unrelated content IDs', () => {
    expect(() => buildPendingContentMigration('../data/skills/fireball')).toThrow(/unsupported/)
    expect(() => buildPendingContentMigration('skills/fireball')).toThrow(/unsupported/)
  })
})
