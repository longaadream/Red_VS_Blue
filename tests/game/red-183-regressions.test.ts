import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { prepareAction } from '@/lib/game/targeting'
import type { BattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function json(path: string) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

describe('RED-183 character rules and selection UI regressions', () => {
  it('keeps Tails Twin Flight immunity and inoperable buffs at two turns', () => {
    const skill = json('data/skills/tails-twin-flight.json')
    expect(skill.description).toContain('持续2回合')
    expect(skill.code).toContain('currentDuration:2,remainingDuration:2')
    expect(skill.code).toContain('turns:2')
  })

  it('uses Manhattan distance for Naruto candidates and execution', () => {
    const skill = json('data/skills/naruto-shadow-clone.json')
    const naruto = makePiece({ instanceId: 'naruto-red183', templateId: 'naruto', ownerPlayerId: 'player-red', x: 1, y: 1 }) as any
    naruto.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [naruto], width: 8, height: 8, currentPlayerId: 'player-red', phase: 'action' })
    state.skillsById[skill.id] = skill
    const base = { type: 'useBasicSkill', playerId: 'player-red', pieceId: naruto.instanceId, skillId: skill.id } as BattleAction
    const option = prepareAction(state, base)
    expect(option.kind).toBe('needOption')
    if (option.kind !== 'needOption') return
    const target = prepareAction(state, {
      ...base, selectedOption: 'summon', selectionId: option.selectionId, stateRevision: option.stateRevision,
    } as BattleAction)
    expect(target.kind).toBe('needTarget')
    if (target.kind !== 'needTarget') return
    expect(target.candidates).toContainEqual({ type: 'cell', x: 4, y: 3 })
    expect(target.candidates).not.toContainEqual({ type: 'cell', x: 5, y: 5 })
    expect(skill.targeting.steps[1].distanceMetric).toBe('manhattan')
    expect(skill.code).toContain('Math.abs(pos.x - caster.x) + Math.abs(pos.y - caster.y)')
  })

  it('uses the approved Grimmjow wording and hides the Recall number from its result message', () => {
    expect(json('data/skills/grimmjow-hunting-instinct.json').description).toBe(
      '每当一名敌人行动后，若其在格力姆乔4格内，格力姆乔可移动至2格内1个空格；若与其相邻，攻击该敌人2次，每次造成75%攻击力的物理伤害。',
    )
    const recall = json('data/skills/recall.json')
    expect(recall.concealTargetInBattleLog).toBe(true)
    expect(recall.code).not.toContain("' enemy actions'")
  })

  it('keeps selection, encyclopedia, history, tutorial, and related-card UI contracts visible in source', () => {
    const selection = readFileSync(resolve(process.cwd(), 'data/pages/piece-selection.html'), 'utf8')
    const battle = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const pieces = readFileSync(resolve(process.cwd(), 'data/pages/pieces.html'), 'utf8')
    const history = readFileSync(resolve(process.cwd(), 'data/pages/js/battle-ui/battle-action-history.js'), 'utf8')

    expect(selection).toContain("DECK_PRESET_SCHEMA_VERSION = 1")
    expect(selection).toContain('function savePreset()')
    expect(selection).toContain('function deleteSelectedPreset()')
    expect(selection).toContain("' | 充能点：' + sk.chargeCost")
    expect(battle).toContain("metaParts.join(' · ')")
    expect(battle).not.toContain("metaParts.join(' 路 ')")
    expect(pieces).toContain('`🔋${skillData.chargeCost} 充能`')
    expect(pieces).not.toContain('skillData.maxCharges || skillData.chargeCost')
    expect(battle).toContain('function renderHandCardFace(card, definition)')
    expect(battle).toContain("skId === 'shield-of-light' && sp.templateId === 'uther'")
    expect(battle).toContain("cell.classList.add(entry.role === 'source' ? 'history-source' : 'history-target')")
    expect(history).toContain("event.kind === 'statusAdded' || event.kind === 'statusRemoved'")
  })
})
