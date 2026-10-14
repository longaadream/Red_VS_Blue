import { describe, expect, it } from 'vitest'

import { capturePieceInstance } from '../../lib/game/author-instance-state'
import { createDeclaredSummonQueueWriter, createEffectChain, withEffectChain } from '../../lib/game/effect-batch'
import { toPublicBattleState } from '../../lib/game/deployment'
import { drainBattleEffectChain } from '../../lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '../../lib/game/rule-runtime'
import type { AuthoredSummonSpec } from '../../lib/game/author-summon-schema'
import type { BattleState } from '../../lib/game/turn'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const CAPABILITY = {
  version: 1,
  recipe: 'authored-piece',
  maxSummons: 4,
  modes: ['new-instance', 'return-instance'],
} as const

function run(state: BattleState, sourceId: string, summons: readonly AuthoredSummonSpec[]) {
  const chain = createEffectChain({ actionId: 'author-schema:action', chainId: 'author-schema:chain', turn: 1, rootSeed: 252 })
  createDeclaredSummonQueueWriter(chain, 'author-schema', CAPABILITY).push({ sourceId, summons })
  return withRuleRuntime(new RuleRuntime({ rootSeed: 252, tick: 4 }), () => withEffectChain(state, chain, () => drainBattleEffectChain(state, chain)[0].result))
}

type TestDisplayBinding = { targetId: string; display: Record<string, unknown> }

describe('generic authored summon template and display records', () => {
  it('materializes stable base stats from a detached copy and keeps behavior containers explicit', () => {
    const source = asPieceInstance(makePiece({
      instanceId: 'source', currentHp: 37, maxHp: 80, attack: 14, moveRange: 4,
      skills: [{ skillId: 'source-skill', currentCooldown: 2 }],
      statusTags: [{ id: 'source-status', type: 'source-status', stacks: 3 }],
    }))
    source.isCore = true
    source.name = '本体'
    source.defense = 6
    source.buffs = [{ type: 'armor', value: 2, duration: 3, source: 'test' }]
    source.debuffs = [{ type: 'slow', value: 1, duration: 2, source: 'test' }]
    source.shield = 5
    source.ruleTags = ['snapshot-rule']
    source.displaySkills = [{ skillId: 'biotic-grenade', currentCooldown: 1 }]
    source.rules = [{ id: 'snapshot-rule' } as never]
    const state = makeState({ pieces: [source] })
    const extensionState = (state as unknown as { extensions: { flowState: unknown[] } }).extensions
    extensionState.flowState = [{
      schemaVersion: 1, scope: 'piece', entityId: source.instanceId, ownerPlayerId: source.ownerPlayerId,
      namespace: 'snapshot', name: 'value', value: { nested: ['kept'] }, lifetime: 'while-alive', projectionVisibility: 'owner',
    }, {
      schemaVersion: 1, scope: 'piece', entityId: source.instanceId, ownerPlayerId: source.ownerPlayerId,
      namespace: 'snapshot', name: 'scalar', value: 3, lifetime: 'battle', projectionVisibility: 'public',
    }]
    const snapshot = capturePieceInstance(state, source.instanceId)
    expect(snapshot.fields).toMatchObject({
      buffs: source.buffs, debuffs: source.debuffs, shield: 5, ruleTags: ['snapshot-rule'],
      displaySkills: source.displaySkills, rules: [{ id: 'snapshot-rule' }],
    })
    expect(snapshot.flowState).toHaveLength(2)
    const result = run(state, source.instanceId, [{
      mode: 'new-instance', x: 2, y: 1,
      template: {
        baseSnapshot: snapshot,
        moveRange: 0,
        skills: [],
        statusTags: [],
        rules: [],
        extension: { cloneMarker: true },
      },
    }]) as { success: boolean }

    expect(result.success).toBe(true)
    expect(state.pieces[1]).toMatchObject({
      name: '本体', currentHp: 37, maxHp: 80, attack: 14, defense: 6, moveRange: 0,
      skills: [], statusTags: [], extension: { cloneMarker: true }, noKillCharge: true, isCore: false,
    })
    expect(state.pieces[1].instanceId).not.toBe(source.instanceId)
    expect(state.pieces[1].x).toBe(2)
    expect(state.pieces[1].y).toBe(1)
  })

  it('preserves separate same-definition skills and their per-instance extension', () => {
    const source = asPieceInstance(makePiece({ instanceId:'source' }))
    source.isCore = true
    const state = makeState({ pieces:[source] })
    run(state, source.instanceId, [{ mode:'new-instance', x:2, y:1, template:{
      baseSnapshot:capturePieceInstance(state, source.instanceId), isCore:true,
      skills:[{skillId:'biotic-grenade', extension:{count:1}}, {skillId:'biotic-grenade', extension:{count:2}}],
    }}])
    expect(state.pieces[1]).toMatchObject({ isCore:true, noKillCharge:false, skills:[
      {skillId:'biotic-grenade', extension:{count:1}}, {skillId:'biotic-grenade', extension:{count:2}},
    ] })
  })

  it('uses the explicit owner faction when the source belongs to the other player', () => {
    const source = asPieceInstance(makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', faction: 'red' }))
    const state = makeState({ pieces: [source] })

    const result = run(state, source.instanceId, [{
      mode: 'new-instance', x: 2, y: 1,
      template: {
        ownerPlayerId: 'player-blue',
        templateId: 'blue-summon', name: 'Blue summon', maxHp: 20, attack: 3, defense: 1, moveRange: 2,
      },
    }]) as { success: boolean }

    expect(result.success).toBe(true)
    expect(state.pieces[1]).toMatchObject({ ownerPlayerId: 'player-blue', faction: 'blue', templateId: 'blue-summon' })
  })

  it('stores audience snapshots through the existing public projection', () => {
    const source = asPieceInstance(makePiece({ instanceId: 'source', attack: 12 }))
    source.name = '真实名称'
    const state = makeState({ pieces: [source] })
    run(state, source.instanceId, [{
      mode: 'new-instance', x: 2, y: 1,
      template: { baseSnapshot: capturePieceInstance(state, source.instanceId), skills: [], statusTags: [], rules: [] },
      display: {
        audiences: {
          public: { name: '伪装名称', attack: 1 },
          owner: { name: '真实名称', attack: 12 },
        },
      },
    }])

    const summoned = state.pieces[1]
    const owner = toPublicBattleState(state, 'player-red')
    const enemy = toPublicBattleState(state, 'player-blue')
    const ownerBindings = (owner.extensions?.skillPresentation as { bindings?: TestDisplayBinding[] } | undefined)?.bindings ?? []
    const enemyBindings = (enemy.extensions?.skillPresentation as { bindings?: TestDisplayBinding[] } | undefined)?.bindings ?? []
    expect(ownerBindings.filter(binding => binding.targetId === summoned.instanceId).at(-1)?.display)
      .toMatchObject({ name: '真实名称', attack: 12 })
    expect(enemyBindings.filter(binding => binding.targetId === summoned.instanceId)).toHaveLength(1)
    expect(enemyBindings.find(binding => binding.targetId === summoned.instanceId)?.display)
      .toMatchObject({ name: '伪装名称', attack: 1 })
    expect(JSON.stringify(enemy)).not.toContain('sourcePieceId')
  })
})
