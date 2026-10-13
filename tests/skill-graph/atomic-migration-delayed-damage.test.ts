import { expect, it } from 'vitest'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicDelayedDamageRecipe, captureBlackCoffinPlayer } from '../../lib/skill-graph/atomic-migration-delayed-damage'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { buildProjectileSkillGraph } from '../../scripts/migrate-semantic-projectile-skills'
import { buildFollowupRuleGraph } from '../../scripts/migrate-semantic-followup-rules'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph, type GameplayModuleDescriptor } from '../../lib/skill-graph/module-types'

it('captures Black Coffin ownership in its creation graph and compiles the player-sourced follow-up', () => {
  const original = buildProjectileSkillGraph('aizen-black-coffin')
  const graph = captureBlackCoffinPlayer(original)
  expect(graph).not.toEqual(original)
  expect(captureBlackCoffinPlayer(graph)).toEqual(graph)
  expect(compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code).toContain('sourcePlayerId')
  const followup = rewriteAtomicGraph(buildFollowupRuleGraph('rule-aizen-black-coffin-end'), atomicDelayedDamageRecipe)
  expect(compileGameplayModuleGraph(followup, GAMEPLAY_MODULE_REGISTRY).code).not.toContain('Black coffin damage source is unavailable')
  expect(rewriteAtomicGraph(followup, atomicDelayedDamageRecipe)).toEqual(followup)
})

it.each(['living', 'departed'])('uses the saved player without consulting the %s caster', mode => {
  const fixture: GameplayModuleDescriptor = { id: 'fixture.refs', version: '1', label: 'fixture', inputs: [], outputs: [
    { name: 'player', type: 'player' }, { name: 'piece', type: 'piece', nullable: true }, { name: 'target', type: 'piece' },
  ], allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: false }, lower: () => 'context' }
  const registry = { get: (id: string, version?: string) => id === fixture.id ? fixture : GAMEPLAY_MODULE_REGISTRY.get(id, version) }
  const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record' }], body: [
    { kind: 'call', id: 'refs', module: 'fixture.refs', version: '1' },
    { kind: 'call', id: 'hit', module: 'effect.damage-with-player-fallback', version: '1', inputs: {
      playerSource: { kind: 'output', node: 'refs', port: 'player' }, pieceSource: { kind: 'output', node: 'refs', port: 'piece' }, target: { kind: 'output', node: 'refs', port: 'target' }, amount: { kind: 'literal', value: 7 },
    }, parameters: { damageType: 'true', skillId: 'delayed' } },
    { kind: 'return', id: 'done', value: { kind: 'output', node: 'hit', port: 'result' } },
  ] }
  const compiled = compileGameplayModuleGraph(rewriteAtomicGraph(graph, atomicDelayedDamageRecipe), registry)
  const calls: unknown[][] = []
  const flow = { query: { player: (id: string) => ({ playerId: id, name: '红方' }) }, effects: { damage: (...args: unknown[]) => { calls.push(args); return { success: true, damage: 7 } } } }
  new Function('flow', 'return (' + compiled.code + ')')(flow)({ player: 'red', piece: mode === 'living' ? 'caster' : null, target: 'victim' })
  expect(calls).toEqual([[{ kind: 'player', instanceId: 'red', ownerPlayerId: 'red', name: '红方' }, 'victim', 7, 'true', 'delayed', 'floor']])
})
