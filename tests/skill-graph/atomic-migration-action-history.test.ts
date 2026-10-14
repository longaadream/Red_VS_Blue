import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicActionHistoryRecipe } from '../../lib/skill-graph/atomic-migration-action-history'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const piece = makePiece({ instanceId: 'source' })
type HistoryAction = { type: string; turn?: number; payload: Record<string, unknown> }
const actions: HistoryAction[] = [
  { type: 'move', payload: { pieceId: 'source', path: [{ x: 1, y: 1 }] } },
  { type: 'useBasicSkill', turn: 2, payload: { pieceId: 'source', skillId: 'tested' } },
  { type: 'useBasicSkill', turn: 3, payload: { pieceId: 'source', skillId: 'tested' } },
  { type: 'useBasicSkill', turn: 3, payload: { pieceId: 'source', skillId: 'tested', interrupted: false } },
  { type: 'useBasicSkill', turn: 3, payload: { pieceId: 'source', skillId: 'tested', interrupted: true } },
  { type: 'useBasicSkill', turn: 3, payload: { pieceId: 'source', skillId: 'other' } },
  { type: 'useBasicSkill', turn: 3, payload: { pieceId: 'other', skillId: 'tested' } },
  { type: 'move', payload: { pieceId: 'source', path: [{ x: 1, y: 1 }, { x: 1, y: 2 }] } },
  { type: 'move', payload: { pieceId: 'other', path: [] } },
]
function graph(module: string, port: string): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'number' }], body: [
    { kind: 'call', id: 'holder', module: 'ref.holder', version: '1' },
    { kind: 'call', id: 'history', module, version: '1', inputs: { piece: { kind: 'output', node: 'holder', port: 'piece' } }, ...(module === 'event.skill-cast-count' ? { parameters: { skillId: 'tested' } } : {}) },
    { kind: 'return', id: 'done', value: { kind: 'output', node: 'history', port } },
  ] }
}
function run(source: GameplayModuleGraph, history: typeof actions) {
  const battle = makeState({ pieces: [piece] }); battle.turn.turnNumber = 3
  battle.actions = structuredClone(history).map(action => ({ playerId: 'player-red', turn: 3, ...action }))
  const before = structuredClone(battle), context = { piece, playerId: piece.ownerPlayerId }
  const flow = createFlowRuntime(battle, context, 'skill', {})
  const code = compileGameplayModuleGraph(source, GAMEPLAY_MODULE_REGISTRY).code
  const result = new Function('flow', 'battle', 'return (' + code + ')')(flow, battle)(context)
  expect(battle).toEqual(before)
  return result
}
describe('action history uses ordinary fields and collection queries', () => {
  it.each([['event.last-move-distance', 'distance'], ['event.skill-cast-count', 'count']] as const)('%s retains selection, order and no-history behavior', (module, port) => {
    const original = graph(module, port), migrated = rewriteAtomicGraph(original, atomicActionHistoryRecipe)
    expect(run(migrated, actions)).toBe(2)
    expect(run(migrated, actions)).toBe(run(original, actions))
    expect(run(migrated, [])).toBe(run(original, []))
    expect(rewriteAtomicGraph(migrated, atomicActionHistoryRecipe)).toEqual(migrated)
  })
  it('uses only the most recent matching move even if it has no path', () => {
    const original = graph('event.last-move-distance', 'distance')
    const history = [...actions, { type: 'move', payload: { pieceId: 'source' } }]
    expect(run(rewriteAtomicGraph(original, atomicActionHistoryRecipe), history)).toBe(run(original, history))
  })
})
