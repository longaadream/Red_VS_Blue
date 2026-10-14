/* eslint-disable @typescript-eslint/no-explicit-any -- production-shaped JSON fixture */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { applyGameplayModuleGraph, assertGameplayModuleDocument } from '../../lib/skill-graph/module-document'
import { synchronizeGameplayTargetBinding } from '../../lib/skill-graph/author-target-binding'
import { prepareAction } from '../../lib/game/targeting'
import { applyBattleAction } from '../../lib/game/turn'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function shadowClone(): JsonRecord {
  return JSON.parse(readFileSync('data/skills/naruto-shadow-clone.json', 'utf8')) as JsonRecord
}

function selectionGraph(modules: Array<{ id: string; module: string; parameters?: JsonRecord }>): JsonRecord {
  return {
    version: 'rvb-gameplay-modules/v1',
    surface: 'skill',
    body: [
      ...modules.map(statement => ({ kind: 'call', version: '1', ...statement })),
      { kind: 'return', id: 'done' },
    ],
  }
}

describe('author target graph bindings', () => {
  it('keeps the targeting declaration, text, preview, and runtime candidate on one target node', () => {
    const original = shadowClone()
    const graph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    const target = graph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    target.parameters.range = 6

    const edited = applyGameplayModuleGraph(original, graph, 'code') as JsonRecord
    expect(edited.targeting.steps[1].range).toBe(6)
    expect(edited.targeting.steps[1].distanceMetric).toBe('manhattan')
    expect(edited.targeting.steps[1].allowSourceOccupantOptions).toEqual(['teleport'])
    expect(edited.targeting.steps[0]).toEqual(original.targeting.steps[0])
    expect(edited.targetText).toBe('地格（6）')
    expect(edited.description).toContain('地格（6）')
    expect(edited.gameplayModules.targetBindings).toMatchObject({
      version: 'rvb-gameplay-target-binding/v1',
      entry: 'code',
      targets: [{ node: 'target', stepIndex: 1, targetIndex: 0, type: 'cell' }],
    })

    const previewGraph = edited.gameplayModules.entries.previewCode.graph as JsonRecord
    const preview = previewGraph.body.find((statement: JsonRecord) => statement?.id === 'preview') as JsonRecord
    expect(preview.inputs.description.value).toBe(edited.description)
    expect(() => assertGameplayModuleDocument(edited)).not.toThrow()
    expect(() => assertGameplayModuleDocument({
      ...edited,
      targeting: { ...edited.targeting, steps: edited.targeting.steps.map((step: JsonRecord, index: number) => index === 1 ? { ...step, range: 5 } : step) },
    })).toThrow(/stale/)

    const source = makePiece({
      instanceId: 'naruto', ownerPlayerId: 'player-red', x: 0, y: 0,
      skills: [{ skillId: 'naruto-shadow-clone', currentCooldown: 0, usesRemaining: -1 }],
    })
    const state = makeState({ pieces: [source], width: 8, height: 2 })
    state.skillsById['naruto-shadow-clone'] = edited as never
    const root = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'naruto', skillId: 'naruto-shadow-clone' }
    const option = prepareAction(state, root)
    expect(option.kind).toBe('needOption')
    const targetAction = {
      ...root,
      selectedOption: 'summon',
      selectionId: option.kind === 'needOption' ? option.selectionId : undefined,
      stateRevision: option.kind === 'needOption' ? option.stateRevision : undefined,
    }
    const targetPreparation = prepareAction(state, targetAction)
    expect(targetPreparation).toMatchObject({ kind: 'needTarget', targetType: 'cell', range: 6 })
    if (targetPreparation.kind === 'needTarget') {
      expect(targetPreparation.candidates).toEqual(expect.arrayContaining([{ type: 'cell', x: 6, y: 0 }]))
    }
  })

  it('preserves the option prefix and rejects ambiguous custom wording without guessing', () => {
    const original = shadowClone()
    const originalOption = clone(original.targeting.steps[0])
    const graph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    const target = graph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    target.parameters.range = 6
    original.targetText = '地格（5）或范围5'

    const edited = applyGameplayModuleGraph(original, graph, 'code') as JsonRecord
    expect(edited.targeting.steps[0]).toEqual(originalOption)
    expect(edited.targeting.steps[1].range).toBe(6)
    expect(edited.targetText).toBe('地格（5）或范围5')
    expect(edited.description).toContain('地格（5）')
    expect(Object.prototype.propertyIsEnumerable.call(edited, '__gameplayTargetBindingWarnings')).toBe(false)
    expect(edited.__gameplayTargetBindingWarnings).toEqual(expect.arrayContaining([expect.stringMatching(/唯一数字 token/)]))
  })

  it('leaves graph-owned targeting untouched when no legacy declaration exists', () => {
    const original = shadowClone()
    delete original.targeting
    const graph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    const target = graph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    const option = graph.body.find((statement: JsonRecord) => statement?.id === 'mode') as JsonRecord
    expect(option.inputs.options).toMatchObject({ kind: 'output', node: 'mode-options' })
    target.parameters.range = 6

    const edited = applyGameplayModuleGraph(original, graph, 'code') as JsonRecord
    expect(edited.targeting).toBeUndefined()
    expect(edited.gameplayModules.targetBindings).toBeUndefined()
  })

  it('synchronizes graph-owned root target metadata for new, edited, and removed selections', () => {
    const original: JsonRecord = {
      id: 'new-author-skill',
      kind: 'active',
      type: 'normal',
      range: 'single',
      targetType: 'piece',
      filter: 'enemy',
      requiresTarget: true,
    }
    const cell = selectionGraph([{
      id: 'landing', module: 'author.choice.target-cell',
      parameters: { range: 5, filter: 'all', requireWalkable: true, requireUnoccupied: true },
    }])

    const created = applyGameplayModuleGraph(original, cell, 'code') as JsonRecord
    expect(created.targetType).toBe('cell')
    expect(created.filter).toBe('all')
    expect(created.requiresTarget).toBe(true)

    const source = asPieceInstance(makePiece({
      instanceId: 'author', ownerPlayerId: 'player-red', x: 0, y: 0,
      skills: [{ skillId: 'new-author-skill', currentCooldown: 0, usesRemaining: -1 }],
    }))
    const state = makeState({ pieces: [source], width: 4, height: 4 })
    state.skillsById['new-author-skill'] = created as never
    const root = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: 'author', skillId: 'new-author-skill' }
    const prepared = prepareAction(state, root)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind === 'needTarget') {
      expect(() => applyBattleAction(state, {
        ...root, targetX: 1, targetY: 0,
        selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
      })).not.toThrow()
    }

    const piece = selectionGraph([{
      id: 'victim', module: 'author.choice.target-piece',
      parameters: { range: 4, filter: 'ally' },
    }])
    const changed = applyGameplayModuleGraph(created, piece, 'code') as JsonRecord
    expect(changed.targetType).toBe('piece')
    expect(changed.filter).toBe('ally')
    expect(changed.requiresTarget).toBe(true)

    const noSelection = selectionGraph([])
    const removed = applyGameplayModuleGraph(changed, noSelection, 'code') as JsonRecord
    expect(removed.targetType).toBeUndefined()
    expect(removed.filter).toBeUndefined()
    expect(removed.requiresTarget).toBe(false)
  })

  it('updates or removes only numeric legacy target ranges while preserving UI range modes', () => {
    const numeric: JsonRecord = { id: 'numeric-range-skill', range: 5, targetType: 'piece', filter: 'enemy', requiresTarget: true }
    const target = selectionGraph([{ id: 'landing', module: 'author.choice.target-cell', parameters: { range: 6, filter: 'all' } }])
    const edited = applyGameplayModuleGraph(numeric, target, 'code') as JsonRecord
    expect(edited.range).toBe(6)

    const removed = applyGameplayModuleGraph(edited, selectionGraph([]), 'code') as JsonRecord
    expect(removed.range).toBeUndefined()

    const uiMode: JsonRecord = { id: 'ui-range-skill', range: 'single', targetType: 'piece', filter: 'enemy', requiresTarget: true }
    const uiEdited = applyGameplayModuleGraph(uiMode, target, 'code') as JsonRecord
    expect(uiEdited.range).toBe('single')
    for (const mode of ['single', 'area', 'self']) {
      const removed = applyGameplayModuleGraph({ ...uiEdited, range: mode }, selectionGraph([]), 'code') as JsonRecord
      expect(removed.range).toBe(mode)
      expect(removed.requiresTarget).toBe(false)
    }
  })

  it('does not clear legacy target metadata for an option-only graph', () => {
    const original: JsonRecord = { id: 'legacy-ref-target', targetType: 'piece', filter: 'enemy', requiresTarget: true }
    const optionOnly = {
      version: 'rvb-gameplay-modules/v1', surface: 'skill',
      body: [{ kind: 'call', id: 'mode', module: 'author.choice.option', version: '1' }],
    }
    const result = synchronizeGameplayTargetBinding(original, optionOnly, optionOnly, 'code')
    expect(result.rootTargetMetadata).toBeUndefined()
  })

  it('does not sync runtime target metadata from a preview entry', () => {
    const original: JsonRecord = { id: 'preview-only-target', targetType: 'piece', filter: 'enemy', requiresTarget: true }
    const preview = selectionGraph([{ id: 'landing', module: 'author.choice.target-cell', parameters: { range: 5, filter: 'all' } }])
    const result = synchronizeGameplayTargetBinding(original, undefined, preview, 'previewCode')
    expect(result.rootTargetMetadata).toBeUndefined()
  })

  it('uses the first unconditional target for root metadata while preserving later stages', () => {
    const original: JsonRecord = { id: 'multi-stage-skill', targetType: 'piece', filter: 'enemy', requiresTarget: true }
    const graph = selectionGraph([
      { id: 'landing', module: 'author.choice.target-cell', parameters: { range: 5, filter: 'all' } },
      { id: 'victim', module: 'author.choice.target-piece', parameters: { range: 3, filter: 'enemy' } },
    ])

    const edited = applyGameplayModuleGraph(original, graph, 'code') as JsonRecord
    expect(edited.targetType).toBe('cell')
    expect(edited.filter).toBe('all')
    expect(edited.requiresTarget).toBe(true)
    expect(edited.gameplayModules.targetBindings).toBeUndefined()
    expect(() => assertGameplayModuleDocument(edited)).not.toThrow()
  })

  it('rejects multiple target interactions instead of guessing declaration order', () => {
    const original = shadowClone()
    const graph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    const target = graph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    graph.body.splice(4, 0, { ...clone(target), id: 'target-two' })

    expect(() => applyGameplayModuleGraph(original, graph, 'code')).toThrow(/数量不一致/)
  })

  it('rejects duplicate target node identities without guessing a binding', () => {
    const original = shadowClone()
    const previousGraph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    const graph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    const target = graph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    graph.body.splice(4, 0, clone(target))

    const result = synchronizeGameplayTargetBinding(original, previousGraph, graph, 'code')
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.stringMatching(/不唯一|重复/)]))
  })

  it('retains direct graph-input text bindings while rebasing a target edit', () => {
    const original = shadowClone()
    const graph = original.gameplayModules.entries.code.graph as JsonRecord
    graph.inputs = [{ name: 'authorRangeText', type: 'string' }]
    graph.inputBindings = { authorRangeText: '五' }
    original.gameplayModules.textBindings = {
      description: {
        template: '选择范围{{rangeText}}。',
        values: { rangeText: { entry: 'code', input: 'authorRangeText' } },
      },
    }
    original.description = '选择范围五。'
    const editedGraph = clone(graph)
    const target = editedGraph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    target.parameters.range = 6

    const edited = applyGameplayModuleGraph(original, editedGraph, 'code') as JsonRecord
    expect(edited.description).toBe('选择范围五。')
    expect(edited.gameplayModules.textBindings.description.values.rangeText).toEqual({ entry: 'code', input: 'authorRangeText' })
  })

  it('requires the pre-edit target constraints to match the existing declaration', () => {
    const original = shadowClone()
    original.targeting.steps[1].range = 4
    const graph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    const target = graph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    target.parameters.range = 6

    expect(() => applyGameplayModuleGraph(original, graph, 'code')).toThrow(/原目标约束/)
    expect(original.targeting.steps[1].range).toBe(4)
  })

  it('does not validate legacy target constraints when only a non-target node changes', () => {
    const original = shadowClone()
    original.targeting.steps[1].range = 4
    const graph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    graph.body.splice(graph.body.length - 1, 0, {
      kind: 'call',
      id: 'unrelated-math',
      module: 'math.add',
      version: '1',
      inputs: {
        left: { kind: 'literal', value: 1 },
        right: { kind: 'literal', value: 2 },
      },
    })
    const beforeTargeting = clone(original.targeting)

    const edited = applyGameplayModuleGraph(original, graph, 'code') as JsonRecord
    expect(edited.targeting).toEqual(beforeTargeting)
    expect(edited.gameplayModules.targetBindings).toBeUndefined()
  })

  it('canonicalizes a cell constraint restored to its default and warns about custom wording', () => {
    const original = shadowClone()
    original.targeting.steps[1].requireWalkable = false
    const originalTarget = original.gameplayModules.entries.code.graph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    originalTarget.parameters.requireWalkable = false
    const graph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    const target = graph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    target.parameters.requireWalkable = false
    const editedGraph = clone(graph)
    delete editedGraph.body.find((statement: JsonRecord) => statement?.id === 'target').parameters.requireWalkable

    const edited = applyGameplayModuleGraph(original, editedGraph, 'code') as JsonRecord
    expect(edited.targeting.steps[1].requireWalkable).toBeUndefined()
    expect(edited.targetText).toBe(original.targetText)
    expect(edited.__gameplayTargetBindingWarnings).toEqual(expect.arrayContaining([expect.stringMatching(/筛选|约束/)]))
    expect(() => assertGameplayModuleDocument(edited)).not.toThrow()
  })

  it('replaces the unique range token by position when an earlier number contains the same digit', () => {
    const original = shadowClone()
    original.targetText = '范围15（5）'
    original.description = '选择范围15（5）'
    const preview = original.gameplayModules.entries.previewCode.graph.body.find((statement: JsonRecord) => statement?.id === 'preview') as JsonRecord
    preview.inputs.description.value = original.description
    const graph = clone(original.gameplayModules.entries.code.graph) as JsonRecord
    const target = graph.body.find((statement: JsonRecord) => statement?.id === 'target') as JsonRecord
    target.parameters.range = 6

    const edited = applyGameplayModuleGraph(original, graph, 'code') as JsonRecord
    expect(edited.targetText).toBe('范围15（6）')
    expect(edited.description).toBe('选择范围15（6）')
  })

  it('does not add binding metadata to an untouched legacy document', () => {
    const original = shadowClone()
    assertGameplayModuleDocument(original)
    expect(original.gameplayModules.targetBindings).toBeUndefined()
    expect(original.targeting.steps[1].range).toBe(5)
  })
})
