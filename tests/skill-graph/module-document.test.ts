import { describe, expect, it } from 'vitest'
import {
  applyGameplayModuleGraph, assertGameplayModuleDocument, assertGameplayModuleTransition,
  createGameplayModuleGraph, getGameplayModuleGraph,
} from '../../lib/skill-graph/module-document'
import { applyContentGraphField } from '../../electron-editor/content-graph-document'
import { CONTENT_GRAPH_VERSION } from '../../electron-editor/content-graph'
import { assertCardDefinition, assertSkillDefinition } from '../../lib/game/skills'

const starter = () => createGameplayModuleGraph('skill')

describe('module-owned content documents', () => {
  it('rejects tampered generated code at the actual skill and card admission boundaries', () => {
    const skill = applyGameplayModuleGraph({ id: 'example', kind: 'active', type: 'normal' }, starter())
    expect(() => assertSkillDefinition('example', skill)).not.toThrow()
    expect(() => assertSkillDefinition('example', { ...skill, code: 'function executeSkill() {}' })).toThrow('does not match')
    const card = applyGameplayModuleGraph({ id: 'example', type: 'active', actionPointCost: 0 }, createGameplayModuleGraph('card'))
    expect(() => assertCardDefinition('example', card)).not.toThrow()
    expect(() => assertCardDefinition('example', { ...card, code: 'function executeCard() {}' })).toThrow('does not match')
  })
  it('stores a detached graph snapshot and rejects changed generated code', () => {
    const graph = starter()
    const document = applyGameplayModuleGraph({ id: 'example', description: '保留原文' }, graph)
    expect(() => assertGameplayModuleDocument(document)).not.toThrow()
    expect(document.description).toBe('保留原文')
    expect(getGameplayModuleGraph(document, 'code')).toEqual(graph)
    expect(getGameplayModuleGraph(document, 'code')).not.toBe(graph)
    expect(() => assertGameplayModuleDocument({ ...document, code: 'function executeSkill() {}' })).toThrow('does not match')
  })

  it('prevents stripping graph ownership while allowing legacy content during migration', () => {
    const previous = applyGameplayModuleGraph({ id: 'example' }, starter())
    expect(() => assertGameplayModuleTransition(previous, { id: 'example', code: previous.code })).toThrow('cannot detach')
    expect(() => assertGameplayModuleTransition({ id: 'legacy' }, { id: 'legacy', code: 'legacy' })).not.toThrow()
    expect(() => assertGameplayModuleTransition(previous, { ...previous, description: '新说明' })).not.toThrow()
  })

  it('rejects unknown metadata, compiler versions and mismatched entry surfaces', () => {
    const document = applyGameplayModuleGraph({}, starter())
    const artifact = document.gameplayModules as { version: string; entries: Record<string, unknown> }
    expect(() => assertGameplayModuleDocument({ ...document, gameplayModules: { ...artifact, source: 'arbitrary' } })).toThrow('metadata')
    expect(() => assertGameplayModuleDocument({ ...document, gameplayModules: { ...artifact, entries: { code: { graph: starter(), compilerVersion: 'future' } } } })).toThrow('compiler version')
    expect(() => applyGameplayModuleGraph({}, starter(), 'effectCode')).toThrow('incompatible')
  })

  it('migrates the primary graph without losing its separately authored preview', () => {
    const primary = { version: CONTENT_GRAPH_VERSION, surface: 'skill' as const, entry: 'end', nodes: [{ id: 'end', kind: 'return' as const }] }
    const preview = { ...primary, surface: 'preview' as const }
    const legacy = applyContentGraphField(applyContentGraphField({ id: 'example' }, primary, 'code'), preview, 'previewCode')
    const document = applyGameplayModuleGraph(legacy, starter())
    expect(document.contentGraphField).toBe('previewCode')
    expect(document.previewCode).toBe(legacy.previewCode)
    expect(() => assertGameplayModuleDocument(document)).not.toThrow()
    expect(() => assertGameplayModuleDocument({ ...document, contentGraph: primary, contentGraphField: 'code' })).toThrow('multiple authoring')
  })
})
