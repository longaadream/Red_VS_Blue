/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skill fixtures exercise the trusted content boundary. */
import { beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { dealDamage, loadAllSkillsById, loadRuleById } from '@/lib/game/skills'
import { expireOwnerStatuses } from '@/lib/game/status-lifecycle'
import { applyBattleAction, type BattleAction, type BattleState } from '@/lib/game/turn'
import { prepareAction, targetRefKey } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 2161

function installSkill(state: BattleState, piece: any, skillId: string): void {
  const skill = loadAllSkillsById()[skillId]
  if (!skill) throw new Error(`${skillId} did not load`)
  state.skillsById[skillId] = skill
  piece.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
}

function selectedGridAction(state: BattleState, pieceId: string, skillId: string, x: number, y: number): BattleAction {
  const base = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId, skillId }
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  expect(prepared.candidates.map(targetRefKey)).toContain(`cell:${x},${y}`)
  return { ...base, targetX: x, targetY: y, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
}

beforeEach(() => globalTriggerSystem.clearRules())

describe('RED-216 Muzan active skills', () => {
  it('Blood Whip hits every enemy on all four cardinal lines, including enemies behind another enemy', () => {
    const caster = makePiece({ instanceId: 'muzan', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 4, y: 4, attack: 4 })
    const targets = [
      makePiece({ instanceId: 'north-near', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 3, currentHp: 20, maxHp: 20 }),
      makePiece({ instanceId: 'north-far', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 1, currentHp: 20, maxHp: 20 }),
      makePiece({ instanceId: 'south', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 7, currentHp: 20, maxHp: 20 }),
      makePiece({ instanceId: 'east', ownerPlayerId: 'player-blue', faction: 'blue', x: 7, y: 4, currentHp: 20, maxHp: 20 }),
      makePiece({ instanceId: 'west', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 4, currentHp: 20, maxHp: 20 }),
    ]
    const diagonal = makePiece({ instanceId: 'diagonal', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 5, currentHp: 20, maxHp: 20 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 4, y: 5, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [caster, ...targets, diagonal, ally], width: 9, height: 9 })
    state.players[0].actionPoints = 2
    installSkill(state, caster, 'muzan-blood-whip')

    const base = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: caster.instanceId, skillId: 'muzan-blood-whip' }
    expect(prepareAction(state, base)).toMatchObject({ kind: 'ready' })
    const result = runBattleAction(state, base, { rootSeed: ROOT_SEED }).state

    for (const target of targets) expect(result.pieces.find(piece => piece.instanceId === target.instanceId)?.currentHp).toBe(16)
    expect(result.pieces.find(piece => piece.instanceId === diagonal.instanceId)?.currentHp).toBe(20)
    expect(result.pieces.find(piece => piece.instanceId === ally.instanceId)?.currentHp).toBe(20)
    expect(result.players[0].actionPoints).toBe(1)
  })

  it('keeps later Blood Whip targets after the first target reflects lethal damage', () => {
    const caster = makePiece({ instanceId: 'muzan-whip-reflect', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 4, currentHp: 15, maxHp: 15 })
    const first = makePiece({ instanceId: 'whip-reflect-first', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1, currentHp: 20, maxHp: 20 })
    const later = makePiece({ instanceId: 'whip-reflect-later', ownerPlayerId: 'player-blue', faction: 'blue', x: 0, y: 1, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [caster, first, later], width: 4, height: 3 })
    state.players[0].actionPoints = 2
    state.extensions!.muzanDeaths = 0
    installSkill(state, caster, 'muzan-blood-whip')
    let reflected = false
    globalTriggerSystem.addRules([
      {
        id: 'reflect-whip-first-hit', name: 'reflect-whip-first-hit', description: '', trigger: { type: 'afterDamageTaken' },
        effect: (_battle: any, context: any) => {
          if (context.piece?.instanceId !== first.instanceId || reflected) return { success: true }
          reflected = true
          if (!context.damageQueue) throw new Error('afterDamageTaken did not expose damageQueue')
          context.damageQueue.push({ attacker: first, target: caster, damage: 99, damageType: 'true', skillId: 'test-whip-reflection' })
          return { success: true }
        },
      },
      {
        id: 'count-whip-muzan-death', name: 'count-whip-muzan-death', description: '', trigger: { type: 'onPieceDied' },
        effect: (battle: any, context: any) => {
          if (context.sourcePiece?.instanceId === caster.instanceId) battle.extensions.muzanDeaths += 1
          return { success: true }
        },
      },
    ] as any)

    const base = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: caster.instanceId, skillId: 'muzan-blood-whip' }
    const result = runBattleAction(state, base, { rootSeed: ROOT_SEED }).state
    const corpse = result.graveyard.find(piece => piece.instanceId === caster.instanceId)

    expect(reflected).toBe(true)
    expect(result.pieces.find(piece => piece.instanceId === first.instanceId)?.currentHp).toBe(16)
    expect(result.pieces.find(piece => piece.instanceId === later.instanceId)?.currentHp).toBe(16)
    expect(result.extensions!.muzanDeaths).toBe(1)
    expect(result.pieces.find(piece => piece.instanceId === caster.instanceId)).toBeUndefined()
    expect(corpse?.currentHp).toBe(0)
    expect(corpse?.statusTags).not.toContainEqual(expect.objectContaining({ type: 'muzan-damage-reduction' }))
  })

  it('Demon Body follows a walkable dash path, damages each enemy and roots survivors', () => {
    const caster = makePiece({ instanceId: 'muzan', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 4, currentHp: 15, maxHp: 15 })
    const first = makePiece({ instanceId: 'first', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1, currentHp: 20, maxHp: 20 })
    const second = makePiece({ instanceId: 'second', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 1, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [caster, first, second], width: 8, height: 3 })
    state.players[0].actionPoints = 2
    installSkill(state, caster, 'muzan-demon-body')

    const action = selectedGridAction(state, caster.instanceId, 'muzan-demon-body', 6, 1)
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    const moved = result.pieces.find(piece => piece.instanceId === caster.instanceId)!

    expect(moved).toMatchObject({ x: 6, y: 1 })
    expect(result.pieces.find(piece => piece.instanceId === first.instanceId)?.currentHp).toBe(17)
    expect(result.pieces.find(piece => piece.instanceId === second.instanceId)?.currentHp).toBe(17)
    for (const id of [first.instanceId, second.instanceId]) {
      expect(result.pieces.find(piece => piece.instanceId === id)?.statusTags).toContainEqual(expect.objectContaining({ type: 'root', remainingDuration: 1 }))
    }
    expect(moved.statusTags).toContainEqual(expect.objectContaining({ type: 'muzan-damage-reduction', remainingDuration: 1 }))
    expect(moved.rules).toContainEqual(expect.objectContaining({ id: 'rule-muzan-damage-reduction' }))
    expect(result.players[0].actionPoints).toBe(1)

    const incoming = result.pieces.find(piece => piece.instanceId === first.instanceId)!
    const before = moved.currentHp
    dealDamage(incoming, moved, 10, 'true', result, 'muzan-reduction-test')
    expect(moved.currentHp).toBe(before - 5)
  })

  it('keeps later Demon Body targets after the first target reflects lethal damage', () => {
    const caster = makePiece({ instanceId: 'muzan-body-reflect', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 4, currentHp: 15, maxHp: 15 })
    const first = makePiece({ instanceId: 'body-reflect-first', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1, currentHp: 20, maxHp: 20 })
    const later = makePiece({ instanceId: 'body-reflect-later', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 1, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [caster, first, later], width: 8, height: 3 })
    state.players[0].actionPoints = 2
    state.extensions!.muzanDeaths = 0
    installSkill(state, caster, 'muzan-demon-body')
    let reflected = false
    globalTriggerSystem.addRules([
      {
        id: 'reflect-body-first-hit', name: 'reflect-body-first-hit', description: '', trigger: { type: 'afterDamageTaken' },
        effect: (_battle: any, context: any) => {
          if (context.piece?.instanceId !== first.instanceId || reflected) return { success: true }
          reflected = true
          if (!context.damageQueue) throw new Error('afterDamageTaken did not expose damageQueue')
          context.damageQueue.push({ attacker: first, target: caster, damage: 99, damageType: 'true', skillId: 'test-body-reflection' })
          return { success: true }
        },
      },
      {
        id: 'count-body-muzan-death', name: 'count-body-muzan-death', description: '', trigger: { type: 'onPieceDied' },
        effect: (battle: any, context: any) => {
          if (context.sourcePiece?.instanceId === caster.instanceId) battle.extensions.muzanDeaths += 1
          return { success: true }
        },
      },
    ] as any)

    const action = selectedGridAction(state, caster.instanceId, 'muzan-demon-body', 6, 1)
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    const corpse = result.graveyard.find(piece => piece.instanceId === caster.instanceId)

    expect(reflected).toBe(true)
    expect(result.pieces.find(piece => piece.instanceId === first.instanceId)?.currentHp).toBe(17)
    expect(result.pieces.find(piece => piece.instanceId === later.instanceId)?.currentHp).toBe(17)
    expect(result.extensions!.muzanDeaths).toBe(1)
    expect(result.pieces.find(piece => piece.instanceId === caster.instanceId)).toBeUndefined()
    expect(corpse?.currentHp).toBe(0)
    expect(corpse?.statusTags).not.toContainEqual(expect.objectContaining({ type: 'muzan-damage-reduction' }))
  })

  it('uses the committed dash path after a position reaction rewrites the landing cell', () => {
    const caster = makePiece({ instanceId: 'muzan-rewritten', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 4 })
    const behind = makePiece({ instanceId: 'behind-rewritten', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 1, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [caster, behind], width: 8, height: 3 })
    state.players[0].actionPoints = 2
    installSkill(state, caster, 'muzan-demon-body')
    globalTriggerSystem.addRule({
      id: 'rewrite-muzan-landing', name: 'rewrite-muzan-landing', description: '', trigger: { type: 'beforePiecePositionChange' },
      effect: (_battle, context) => {
        if (context.sourcePiece?.instanceId === caster.instanceId) {
          context.targetX = 3
          context.targetY = 1
        }
        return { success: true }
      },
    })

    const action = selectedGridAction(state, caster.instanceId, 'muzan-demon-body', 6, 1)
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(result.pieces.find(piece => piece.instanceId === caster.instanceId)).toMatchObject({ x: 3, y: 1 })
    expect(result.pieces.find(piece => piece.instanceId === behind.instanceId)?.currentHp).toBe(20)
  })

  it('does not continue Demon Body effects when a path contact kills the caster', () => {
    const caster = makePiece({ instanceId: 'muzan-contact-death', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 4 })
    const enemy = makePiece({ instanceId: 'contact-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [caster, enemy], width: 5, height: 3 })
    state.players[0].actionPoints = 2
    installSkill(state, caster, 'muzan-demon-body')
    globalTriggerSystem.addRule({
      id: 'kill-muzan-on-contact', name: 'kill-muzan-on-contact', description: '', trigger: { type: 'afterPiecePathContact' },
      effect: (_battle, context) => {
        if (context.sourcePiece?.instanceId === caster.instanceId) context.sourcePiece.currentHp = 0
        return { success: true }
      },
    })

    const action = selectedGridAction(state, caster.instanceId, 'muzan-demon-body', 4, 1)
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state

    expect(result.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp).toBe(20)
    expect(result.pieces.find(piece => piece.instanceId === caster.instanceId)?.statusTags).not.toContainEqual(expect.objectContaining({ type: 'muzan-damage-reduction' }))
  })

  it('does not move, damage, or add reduction when Demon Body path is blocked', () => {
    const caster = makePiece({ instanceId: 'muzan', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 4, currentHp: 15, maxHp: 15 })
    const state = makeState({ pieces: [caster], width: 8, height: 3 })
    state.players[0].actionPoints = 2
    installSkill(state, caster, 'muzan-demon-body')
    const wall = state.map.tiles.find(tile => tile.x === 3 && tile.y === 1)!
    wall.props.walkable = false
    const action = selectedGridAction(state, caster.instanceId, 'muzan-demon-body', 6, 1)

    expect(() => runBattleAction(state, action, { rootSeed: ROOT_SEED })).toThrow('冲刺路径被阻挡')
    expect(caster).toMatchObject({ x: 0, y: 1, currentHp: 15 })
    expect(caster.statusTags).toEqual([])
    expect(state.players[0].actionPoints).toBe(2)
  })

  it('keeps Demon Body reduction for the caster turn and expires it at the next owner end', () => {
    const caster = makePiece({ instanceId: 'muzan', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 4, currentHp: 15, maxHp: 15 })
    const state = makeState({ pieces: [caster], width: 4, height: 3 })
    state.players[0].actionPoints = 2
    installSkill(state, caster, 'muzan-demon-body')
    const action = selectedGridAction(state, caster.instanceId, 'muzan-demon-body', 2, 1)
    const result = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
    expect(result.pieces[0].statusTags).toContainEqual(expect.objectContaining({ type: 'muzan-damage-reduction', remainingDuration: 1 }))

    expireOwnerStatuses(result, 'player-red')
    expect(result.pieces[0].statusTags).toContainEqual(expect.objectContaining({ type: 'muzan-damage-reduction', remainingDuration: 1 }))
    result.turn.turnNumber += 1
    expireOwnerStatuses(result, 'player-red')
    expect(result.pieces[0].statusTags).not.toContainEqual(expect.objectContaining({ type: 'muzan-damage-reduction' }))
  })

  it('executes Blood Whip through the direct reducer entry as well as the battle runner', () => {
    const caster = makePiece({ instanceId: 'muzan-direct', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 4 })
    const target = makePiece({ instanceId: 'target-direct', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 2, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [caster, target], width: 3, height: 3 })
    state.players[0].actionPoints = 2
    installSkill(state, caster, 'muzan-blood-whip')

    const result = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId, skillId: 'muzan-blood-whip',
    })

    expect(result.pieces.find(piece => piece.instanceId === target.instanceId)?.currentHp).toBe(16)
    expect(result.players[0].actionPoints).toBe(1)
  })

  it('executes Demon Body through the direct reducer entry', () => {
    const caster = makePiece({ instanceId: 'muzan-direct-body', templateId: 'dark-muzan', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 4 })
    const target = makePiece({ instanceId: 'target-direct-body', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 1, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [caster, target], width: 4, height: 3 })
    state.players[0].actionPoints = 2
    installSkill(state, caster, 'muzan-demon-body')

    const action = selectedGridAction(state, caster.instanceId, 'muzan-demon-body', 3, 1)
    const result = applyBattleAction(state, action)

    expect(result.pieces.find(piece => piece.instanceId === caster.instanceId)).toMatchObject({ x: 3, y: 1 })
    expect(result.pieces.find(piece => piece.instanceId === target.instanceId)?.currentHp).toBe(17)
    expect(result.pieces.find(piece => piece.instanceId === caster.instanceId)?.statusTags).toContainEqual(expect.objectContaining({ type: 'muzan-damage-reduction', remainingDuration: 1 }))
  })

  it('loads the reduction rule independently from the skill definition', () => {
    expect(loadRuleById('rule-muzan-damage-reduction', true)).toMatchObject({
      id: 'rule-muzan-damage-reduction',
      trigger: { type: 'beforeDamageTaken' },
    })
  })
})
