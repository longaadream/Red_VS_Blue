import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBattleAction } from '../../lib/game/battle-runner'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { createRunningTurnTimer } from '../../lib/game/turn-timer'
import { globalTriggerSystem } from '../../lib/game/triggers'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

let previousRules: ReturnType<typeof globalTriggerSystem.getRules>
beforeEach(() => { previousRules = [...globalTriggerSystem.getRules()]; globalTriggerSystem.clearRules() })
afterEach(() => { globalTriggerSystem.clearRules(); globalTriggerSystem.addRules(previousRules) })

function stateWithAuthorChoice() {
  const state = makeState({ pieces: [makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' }), makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 3 })], phase: 'action' })
  const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }], schemas: [
    { id: 'options', version: '1', fields: [{ name: '触发', type: 'string' }] },
  ], body: [
    { kind: 'record.create', id: 'options', schema: 'options', fields: { 触发: { kind: 'literal', value: 'yes' } } },
    { kind: 'call', id: 'pick', module: 'author.choice.option', version: '2', inputs: {
      options: { kind: 'output', node: 'options', port: 'value' }, cancelValue: { kind: 'literal', value: 'no' },
    }, parameters: { valueType: 'string', canCancel: true } },
    { kind: 'call', id: 'save', module: 'extension.declare-battle', version: '1', inputs: { value: { kind: 'output', node: 'pick', port: 'value' } }, parameters: { name: 'cancelledChoice', valueType: 'string' } },
    { kind: 'return', id: 'done', values: { success: { kind: 'literal', value: true } } },
  ] }
  const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
  const execute = new Function('flow', 'context', compiled.code)
  globalTriggerSystem.addRule({
    id: 'author-cancel-end-turn', name: 'author-cancel-end-turn', description: '', trigger: { type: 'endTurn' },
    effect: (battle, event) => {
      if (battle.turn.currentPlayerId !== 'player-red') return { success: true }
      const context = { ...event, piece: battle.pieces.find(piece => piece.instanceId === 'source'), ruleId: 'author-cancel-end-turn' }
      return execute(createFlowRuntime(battle, context, 'rule', {}), context)
    },
  })
  return state
}

function expectCancelledChoice(state: ReturnType<typeof makeState>) {
  expect(state.pendingOptionSelection).toBeUndefined()
  expect(state.extensions?.flowState).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'cancelledChoice', value: 'no' })]))
}

describe('author option cancellation through authoritative actions', () => {
  it('resumes an indexed choice using its typed cancellation value after a manual cancel', () => {
    const pending = runBattleAction(stateWithAuthorChoice(), { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 141 }).state
    const session = pending.pendingOptionSelection!
    expect(session).toMatchObject({ cancelValue: 'no', resumeOnCancel: true })
    const result = runBattleAction(JSON.parse(JSON.stringify(pending)), { type: 'cancelPendingSelection', playerId: 'player-red', selectionId: session.selectionId, stateRevision: session.stateRevision }, { rootSeed: 141 }).state
    expectCancelledChoice(result)
    expect(result.turn.phase).toBe('end')
  })
  it('resumes a choice opened during timeout without treating the cancellation value as an option index', () => {
    const state = stateWithAuthorChoice()
    state.turnTimer = createRunningTurnTimer(state, 0)
    const result = runBattleAction(state, { type: 'turnTimeout', now: state.turnTimer.deadlineAt, clientActionId: 'author-cancel-timeout' }, { rootSeed: 142 }).state
    expectCancelledChoice(result)
    expect(result.turn).toMatchObject({ currentPlayerId: 'player-blue', phase: 'action' })
  })
})
