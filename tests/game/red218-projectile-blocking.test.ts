/* eslint-disable @typescript-eslint/no-explicit-any -- Exercises JSON-authored projectile rules. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { executeSkillFunction, loadRuleById, type SkillDefinition } from '@/lib/game/skills'
import type { BattleState } from '@/lib/game/turn'
import { makePlayer, makePiece, makeState } from '../helpers/minimal-state'

function loadSkill(skillId: string): SkillDefinition {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'skills', `${skillId}.json`), 'utf8')) as SkillDefinition
}

function setTerrain(state: BattleState, x: number, type: 'floor' | 'cover', bulletPassable: boolean) {
  const tile = state.map.tiles.find(candidate => candidate.x === x && candidate.y === 0)
  if (!tile) throw new Error(`Missing test tile (${x},0)`)
  tile.props = { ...tile.props, type, walkable: true, bulletPassable }
}

function runProjectileSkill(skillId: string, pieces: any[], configure?: (state: BattleState) => void) {
  const skill = loadSkill(skillId)
  const state = makeState({ pieces, width: 6, height: 1, currentPlayerId: 'player-red', phase: 'action' })
  configure?.(state)
  const caster = state.pieces[0]
  const result = withRuleRuntime(new RuleRuntime({ rootSeed: 218, tick: 1 }), () => executeSkillFunction(skill, {
    piece: caster,
    target: null,
    targetPosition: { x: 5, y: 0 },
    battle: state,
    skill,
  } as any, state))
  return { result, state }
}

function runRevolverZone(
  pieces: any[],
  configure?: (state: BattleState) => void,
) {
  const state = makeState({ pieces, width: 6, height: 1, currentPlayerId: 'player-red', phase: 'action' })
  state.extensions = {
    coltZones: {
      colt: { sourceId: 'colt', kind: 'revolver', dx: 1, dy: 0, turns: 1 },
    },
  }
  configure?.(state)
  const colt = state.pieces.find(piece => piece.instanceId === 'colt')
  if (!colt) throw new Error('Missing Colt test piece')
  const rule = loadRuleById('rule-colt-zone-endturn', true, true)
  if (!rule) throw new Error('Missing Colt zone rule')
  const result = withRuleRuntime(new RuleRuntime({ rootSeed: 218, tick: 1 }), () => rule.effect(state, {
    type: 'endTurn',
    playerId: colt.ownerPlayerId,
    rulePiece: colt,
    sourcePiece: colt,
  } as any))
  return { result, state }
}

function useTeamPlayers(state: BattleState) {
  state.players = [
    { ...makePlayer('red-caster', 'red'), teamId: 'red' },
    { ...makePlayer('red-ally', 'red'), teamId: 'red' },
    { ...makePlayer('blue-target', 'blue'), teamId: 'blue' },
    { ...makePlayer('blue-teammate', 'blue'), teamId: 'blue' },
  ] as any
}

describe('RED-218 projectile friendly blocking', () => {
  it('stops Alfonso at the first friendly piece', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0 })

    runProjectileSkill('alfonso-kick', [caster, ally, enemy])

    expect(ally.currentHp).toBe(100)
    expect(enemy.currentHp).toBe(100)
  })

  it('lets Black Getsuga pierce enemies but stops before a friendly piece', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10 })
    const firstEnemy = makePiece({ instanceId: 'first-enemy', ownerPlayerId: 'player-blue', x: 1, y: 0 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 0 })
    const secondEnemy = makePiece({ instanceId: 'second-enemy', ownerPlayerId: 'player-blue', x: 3, y: 0 })

    runProjectileSkill('ichigo-black-getsuga-tensho', [caster, firstEnemy, ally, secondEnemy])

    expect(firstEnemy.currentHp).toBe(80)
    expect(ally.currentHp).toBe(100)
    expect(secondEnemy.currentHp).toBe(100)
  })

  it('hits an enemy standing on cover before the cover blocks the enemy behind it', () => {
    const colt = makePiece({ instanceId: 'colt', templateId: 'colt', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 6 })
    const coverEnemy = makePiece({ instanceId: 'cover-enemy', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 20, maxHp: 20 })
    const behindCover = makePiece({ instanceId: 'behind-cover', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 20, maxHp: 20 })

    const { state } = runRevolverZone([colt, coverEnemy, behindCover], current => setTerrain(current, 1, 'cover', false))

    expect(coverEnemy.currentHp).toBe(14)
    expect(behindCover.currentHp).toBe(20)
    expect(state.extensions?.coltZones?.colt).toBeUndefined()
  })

  it('stops the Revolver at a friendly piece between Colt and an enemy', () => {
    const colt = makePiece({ instanceId: 'colt', templateId: 'colt', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 6 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 20, maxHp: 20 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 20, maxHp: 20 })

    const { state } = runRevolverZone([colt, ally, enemy])

    expect(ally.currentHp).toBe(20)
    expect(enemy.currentHp).toBe(20)
    expect(state.extensions?.coltZones?.colt).toBeUndefined()
  })

  it('treats a different owner on the same team as a friendly blocker', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'red-caster', x: 0, y: 0, attack: 10 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'red-ally', x: 1, y: 0 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'blue-target', x: 2, y: 0 })

    runProjectileSkill('alfonso-kick', [caster, ally, enemy], useTeamPlayers)

    expect(ally.currentHp).toBe(100)
    expect(enemy.currentHp).toBe(100)
  })

  it('documents pieces, cover, and walls as projectile blockers with explicit exceptions', () => {
    const glossary = JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'skill-keywords.json'), 'utf8'))
    const projectile = glossary.find((entry: { id: string }) => entry.id === 'projectile')

    expect(projectile.shortDescription).toContain('棋子')
    expect(projectile.shortDescription).toContain('掩体')
    expect(projectile.shortDescription).toContain('墙壁')
    expect(projectile.longDescription).toContain('除非技能说明允许穿透')
  })
})
