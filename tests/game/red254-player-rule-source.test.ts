import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { executeSkillFunction, loadRuleById, type SkillDefinition } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { globalTriggerSystem, TriggerSystem } from '@/lib/game/triggers'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

function amaterasuFixture() {
  const ally = asPieceInstance(makePiece({
    instanceId: 'red-ally',
    ownerPlayerId: 'player-red',
    currentHp: 20,
    maxHp: 20,
    x: 0,
    y: 0,
  }))
  const victim = asPieceInstance(makePiece({
    instanceId: 'blue-victim',
    ownerPlayerId: 'player-blue',
    currentHp: 10,
    maxHp: 10,
    x: 1,
    y: 0,
    statusTags: [{ id: 'burn', type: 'amaterasu-burn', stacks: 1 }],
  }))
  const state = makeState({ pieces: [ally, victim], currentPlayerId: 'player-blue' })
  state.extensions = { amaterasuOwnerPlayerId: 'player-red' }
  const rule = loadRuleById('rule-sasuke-amaterasu-damage', true)
  if (!rule) throw new Error('Missing rule-sasuke-amaterasu-damage fixture')
  state.players[0].rules = [rule]
  return { state, ally, victim }
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED-254 player-rule damage source attribution', () => {
  it('uses the player source when an Itachi-origin burn has no surviving source piece', () => {
    const { state, ally, victim } = amaterasuFixture()

    const result = new TriggerSystem().checkTriggers(state, {
      type: 'endTurn',
      playerId: 'player-blue',
    })

    expect(result.success).toBe(true)
    expect(victim.currentHp).toBe(8)
    expect(state.actions?.filter(action => action.type === 'damage').map(action => action.payload)).toContainEqual(expect.objectContaining({
      sourceId: 'player-red',
      targetId: victim.instanceId,
      damageSource: {
        kind: 'player',
        sourceId: 'player-red',
        playerId: 'player-red',
      },
    }))
    expect(ally.currentHp).toBe(20)
  })
})

function damagePayloads(state: ReturnType<typeof makeState>) {
  return (state.actions || []).filter(action => action.type === 'damage').map(action => action.payload)
}

function tick(fixture: ReturnType<typeof amaterasuFixture>, ruleId = 'rule-sasuke-amaterasu-damage') {
  const rule = loadRuleById(ruleId, true)
  if (!rule) throw new Error('Missing fixture rule ' + ruleId)
  fixture.state.players[0].rules = [rule]
  fixture.state.extensions = { ...fixture.state.extensions, amaterasuCells: [{ x: 5, y: 4 }] }
  return new TriggerSystem().checkTriggers(fixture.state, { type: 'endTurn', playerId: 'player-blue' })
}

it.each(['rule-sasuke-amaterasu-damage', 'rule-sasuke-amaterasu-endturn'])('%s preserves living source and uses player after source death, omission or legacy missing identity', ruleId => {
  for (const mode of ['alive', 'dead', 'missing', 'legacy'] as const) {
    const fixture = amaterasuFixture()
    const caster = asPieceInstance(makePiece({ instanceId: 'original-caster', ownerPlayerId: 'player-red', x: 2, y: 1, currentHp: mode === 'dead' ? 0 : 10 }))
    if (mode !== 'legacy') fixture.victim.statusTags[0].sourcePieceId = caster.instanceId
    if (mode === 'alive') fixture.state.pieces.push(caster)
    if (mode === 'dead') fixture.state.graveyard = [caster]
    tick(fixture, ruleId)
    expect(fixture.victim.currentHp).toBe(8)
    expect(damagePayloads(fixture.state)).toContainEqual(expect.objectContaining({
      sourceId: mode === 'alive' ? caster.instanceId : 'player-red',
      damageSource: { kind: mode === 'alive' ? 'piece' : 'player', sourceId: mode === 'alive' ? caster.instanceId : 'player-red', playerId: 'player-red' },
    }))
  }
})

it('keeps player attribution independent of ally order or absence', () => {
  const outputs = []
  for (const mode of ['forward', 'reverse', 'none']) {
    const fixture = amaterasuFixture()
    const secondAlly = asPieceInstance(makePiece({ instanceId: 'second-ally', ownerPlayerId: 'player-red', x: 3, y: 1 }))
    fixture.state.pieces.push(secondAlly)
    if (mode === 'reverse') fixture.state.pieces.reverse()
    if (mode === 'none') fixture.state.pieces = [fixture.victim]
    tick(fixture)
    outputs.push(damagePayloads(fixture.state).map(payload => payload?.damageSource))
    expect(fixture.victim.currentHp).toBe(8)
  }
  expect(outputs[0]).toEqual(outputs[1])
  expect(outputs[0]).toEqual(outputs[2])
})

it.each(['alive', 'dead', 'missing'])('toxin source %s preserves damage and consumes exactly its own trap', mode => {
  const ally = asPieceInstance(makePiece({ instanceId: 'unrelated-ally', ownerPlayerId: 'player-red', x: 0, y: 0 }))
  const caster = asPieceInstance(makePiece({ instanceId: 'widow', ownerPlayerId: 'player-red', x: 2, y: 1, currentHp: mode === 'dead' ? 0 : 10 }))
  const mover = asPieceInstance(makePiece({ instanceId: 'mover', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 10 }))
  const state = makeState({ pieces: [ally, mover, ...(mode === 'alive' ? [caster] : [])] })
  if (mode === 'dead') state.graveyard = [caster]
  const toxin = { id: 'trap', type: 'lethal-toxin', sourceId: caster.instanceId, value: 1, extraValue: 0, intensity: 4 }
  state.players[0].statusTags = [toxin]
  state.extensions = { tileEffects: [{ tileType: 'lethal-toxin', sourceId: toxin.id, x: 1, y: 0 }] }
  const rule = loadRuleById('rule-blackwidow-toxin-player', true)
  if (!rule) throw new Error('Missing toxin fixture')
  state.players[0].rules = [rule]
  new TriggerSystem().checkTriggers(state, { type: 'afterPiecePositionChange', playerId: 'player-blue', sourcePiece: mover })
  expect(mover.currentHp).toBe(6)
  expect(state.players[0].statusTags).toEqual([])
  expect(state.players[0].rules).toEqual([])
  expect(state.extensions.tileEffects).toEqual([])
  expect(damagePayloads(state)).toContainEqual(expect.objectContaining({
    damageSource: { kind: mode === 'alive' ? 'piece' : 'player', sourceId: mode === 'alive' ? caster.instanceId : 'player-red', playerId: 'player-red' },
  }))
})

it('does not donate damage or kill passives to an unrelated ally and retains contested crystal settlement', () => {
  const fixture = amaterasuFixture()
  Object.assign(fixture.victim, { isCore: true, currentHp: 2 })
  let unrelatedActivations = 0
  for (const type of ['beforeDamageDealt', 'afterDamageDealt', 'afterPieceKilled'] as const) {
    globalTriggerSystem.addRule({ id: 'source-observer-' + type, name: 'source observer', description: '', trigger: { type }, effect: (_battle, context) => {
      if (context.sourcePiece?.instanceId === fixture.ally.instanceId) {
        unrelatedActivations++
        fixture.state.players[0].chargePoints++
      }
      return { success: true }
    } })
  }
  const cp = fixture.state.players.map(player => player.chargePoints)
  tick(fixture)
  expect(unrelatedActivations).toBe(0)
  expect(fixture.state.players.map(player => player.chargePoints)).toEqual(cp)
  expect(fixture.state.graveyard?.some(piece => piece.instanceId === fixture.victim.instanceId)).toBe(true)
  expect(fixture.state.extensions?.tileEffects).toContainEqual(expect.objectContaining({ tileType: 'charge-crystal', x: 1, y: 0 }))
})

it('records Itachi as the actual living source through the real skill before falling back after death', () => {
  const fixture = amaterasuFixture()
  fixture.victim.statusTags = []
  const skill = JSON.parse(readFileSync('data/skills/itachi-amaterasu.json', 'utf8')) as SkillDefinition
  const caster = fixture.ally
  const target = fixture.victim
  const result = withRuleRuntime(new RuleRuntime({ rootSeed: 254, tick: 1 }), () => executeSkillFunction(skill, {
    battle: fixture.state, skill, piece: caster, target, targetPosition: { x: target.x!, y: target.y! }, targets: [{ info: target, pos: { x: target.x!, y: target.y! } }],
  }, fixture.state))
  expect(result.success).toBe(true)
  expect(fixture.state.extensions?.amaterasuCells).toContainEqual(expect.objectContaining({ sourcePieceId: caster.instanceId, ownerPlayerId: caster.ownerPlayerId }))
  expect(fixture.victim.statusTags).toContainEqual(expect.objectContaining({ sourcePieceId: caster.instanceId }))
  tick(fixture)
  expect(damagePayloads(fixture.state)).toContainEqual(expect.objectContaining({ sourceId: caster.instanceId, damageSource: expect.objectContaining({ kind: 'piece' }) }))
  fixture.state.pieces = fixture.state.pieces.filter(piece => piece.instanceId !== caster.instanceId)
  fixture.state.graveyard = [{ ...caster, currentHp: 0 }]
  tick(fixture)
  expect(damagePayloads(fixture.state).at(-1)).toMatchObject({ sourceId: 'player-red', damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' } })
})

it('repeats the same attribution and damage logs under a fixed rule seed', () => {
  function replay() {
    const fixture = amaterasuFixture()
    withRuleRuntime(new RuleRuntime({ rootSeed: 254, tick: 1 }), () => tick(fixture))
    return damagePayloads(fixture.state)
  }
  expect(replay()).toEqual(replay())
})
