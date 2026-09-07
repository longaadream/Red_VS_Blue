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
  it('documents the self-cast AP refund on Shield of Light', () => {
    const shield = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/shield-of-light.json'), 'utf8'))

    expect(shield.description).toContain('若目标是本棋子，你恢复1行动点')
    expect(shield.previewCode).toContain('若目标是本棋子，你恢复1行动点')
  })

  it('keeps Tails Twin Flight immunity and inoperable buffs at two turns', () => {
    const skill = json('data/skills/tails-twin-flight.json')
    const resolveRule = json('data/rules/rule-tails-flight-resolve.json')
    expect(skill.description).toContain('持续2回合')
    expect(skill.description).toContain('作为本棋子的落点')
    expect(skill.description).toContain('相邻的合法地格作为友方棋子的落点')
    expect(skill.description).toContain('接下来的第二个你的回合结束时')
    expect(skill.code).toContain('currentDuration:2,remainingDuration:2')
    expect(skill.code).toContain('turns:2')
    expect(skill.targeting.steps[2].distanceFromSelectedTarget).toEqual({ index: 1, range: 1, minRange: 1 })
    expect(resolveRule.trigger).toEqual({ type: 'endTurn' })
  })

  it('uses Manhattan distance for Naruto candidates and execution', () => {
    const skill = json('data/skills/naruto-shadow-clone.json')
    expect(skill.description).toBe('选择本棋子5格内1个空地格，并秘密选择一项：召唤1个影分身；或将本棋子传送至目标格，并在原地留下1个影分身。影分身受到1次伤害后消散，不能行动，被击杀时不提供充能。')
    expect(skill.previewCode).toContain(skill.description)
    expect(skill.effectTags).toContain('秘密选择')
    const naruto = makePiece({ instanceId: 'naruto-red183', templateId: 'naruto', ownerPlayerId: 'player-red', x: 1, y: 1 })
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
      '敌方棋子行动后，若其位于本棋子4格内，可将本棋子移动至2格内1个空地格。若随后与该敌方棋子相邻，则攻击其2次，每次造成等同于本棋子攻击力75%的物理伤害。',
    )
    const recall = json('data/skills/recall.json')
    expect(recall.description).toContain('秘密选择1个数字')
    expect(recall.effectTags).toContain('秘密选择')
    expect(recall.concealTargetInBattleLog).toBe(true)
    expect(recall.code).not.toContain("' enemy actions'")
  })

  it('keeps selection, encyclopedia, history, tutorial, and related-card UI contracts visible in source', () => {
    const selection = readFileSync(resolve(process.cwd(), 'data/pages/piece-selection.html'), 'utf8')
    const battle = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const pieces = readFileSync(resolve(process.cwd(), 'data/pages/pieces.html'), 'utf8')
    const history = readFileSync(resolve(process.cwd(), 'data/pages/js/battle-ui/battle-action-history.js'), 'utf8')

    expect(selection).toContain('<script src="js/deck-presets.js"></script>')
    expect(selection).toContain('function savePreset()')
    expect(selection).toContain('function deleteSelectedPreset()')
    expect(selection).toContain("if (!alignment) { setPresetStatus('请等待阵营锁定后再保存预设。', true); return }")
    expect(selection).toContain('RvBDeckPresets.isValidSelection(pieceIds, alignment, PIECE_TEMPLATES)')
    expect(selection).toContain("' | 充能点：' + sk.chargeCost")
    expect(battle).toContain("metaParts.join(' · ')")
    expect(battle).not.toContain("metaParts.join(' 路 ')")
    expect(battle).toContain("typeof tutorialActionAllowed === 'function' && !tutorialActionAllowed(tutorialCardAction)")
    expect(battle).toContain("typeof tutorialActionAllowed === 'function' && !tutorialActionAllowed(draftAction)")
    expect(pieces).toContain('`🔋${skillData.chargeCost} 充能`')
    expect(pieces).not.toContain('skillData.maxCharges || skillData.chargeCost')
    expect(battle).toContain('function renderHandCardFace(card, definition)')
    expect(battle).not.toContain('tutorialSelfTarget')
    expect(battle).toContain("cell.classList.add(entry.role === 'source' ? 'history-source' : 'history-target')")
    expect(history).toContain("event.kind === 'statusAdded' || event.kind === 'statusRemoved'")
  })
})
