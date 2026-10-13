import { describe, expect, it, vi } from 'vitest'

import { applyBattleAction, type BattleState } from '../../lib/game/turn'
import { finalizePendingTargetSession } from '../../lib/game/targeting'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
} from '../../lib/skill-graph/module-types'
import { makeState } from '../helpers/minimal-state'

const version = '1'

function descriptor(id: string, expression: string): GameplayModuleDescriptor {
  return {
    id,
    version,
    label: id,
    inputs: [],
    outputs: [],
    allowedSurfaces: ['pending'],
    effects: { pure: false, previewSafe: false, writes: ['test'] },
    lower: () => ({ expression }),
  }
}

function registryOf(...descriptors: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const byKey = new Map(descriptors.map(item => [item.id + '@' + item.version, item]))
  return { get: (id, requestedVersion) => byKey.get(id + '@' + (requestedVersion ?? version)) }
}

describe('active pending generated continuation fault route', () => {
  it('injects diagnostics into applyBattleAction resume and continues independent statements', () => {
    const fail = descriptor('test.pendingFail', '(function () { throw new Error("pending route failure") })()')
    const tail = descriptor('test.pendingTail', 'ctx.battle.extensions.values.push("tail")')
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'pending',
      body: [
        { kind: 'call', id: 'fail', module: fail.id, version, inputs: {} },
        { kind: 'call', id: 'tail', module: tail.id, version, inputs: {} },
      ],
    }
    const compiled = compileGameplayModuleGraph(graph, registryOf(fail, tail))
    const state = makeState({ currentPlayerId: 'player-red', phase: 'action' }) as BattleState
    const extensions = (state.extensions ??= {}) as Record<string, unknown>
    extensions.values = []
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-red',
      title: 'Choose a cell',
      targetType: 'cell',
      filter: 'all',
      canCancel: true,
      effectCode: compiled.code,
    }, 0)
    const target = state.pendingTargetSelection.candidates?.find(candidate => candidate.type === 'cell')
    if (!target || target.type !== 'cell') throw new Error('Expected a pending cell candidate')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let diagnostic: unknown
    try {
      const next = applyBattleAction(state, {
        type: 'pendingTargetSelect',
        playerId: 'player-red',
        targetX: target.x,
        targetY: target.y,
        selectionId: state.pendingTargetSelection.selectionId,
        stateRevision: state.pendingTargetSelection.stateRevision,
      })
      expect((next.extensions as Record<string, unknown>).values).toEqual(['tail'])
      diagnostic = errorSpy.mock.calls.find(call => call[0] === '[gameplay-module-diagnostic]')?.[1]
    } finally {
      errorSpy.mockRestore()
    }
    expect(diagnostic).toMatchObject({
      statementId: 'fail',
      moduleId: 'test.pendingFail',
      surface: 'pending',
      contentId: expect.stringMatching(/^pending-/),
      actorPlayerId: 'player-red',
      message: 'pending route failure',
    })
  })
})
