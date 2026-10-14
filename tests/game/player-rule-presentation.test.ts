import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { convertToTriggerRule } from '@/lib/game/rule-loader'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'

const sourceRule = JSON.parse(readFileSync('data/rules/rule-soul-fracture-player.json', 'utf8')) as Record<string, unknown>

describe('authored player rule presentation metadata', () => {
  it('keeps an authored iconPath through cold and cached rule loads', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-player-rule-presentation-'))
    const previousRoot = process.env.RVB_PROFILE_ROOT
    const iconPath = 'images/effect-icons/player-soul-fracture.svg'
    const authoredRule: Record<string, unknown> = { ...sourceRule, iconPath }

    mkdirSync(join(root, 'data', 'rules'), { recursive: true })
    writeFileSync(
      join(root, 'data', 'rules', 'rule-soul-fracture-player.json'),
      JSON.stringify(authoredRule),
      'utf8',
    )

    try {
      process.env.RVB_PROFILE_ROOT = root
      clearRuleCache()

      const cold = loadRuleById('rule-soul-fracture-player', true, true) as unknown as Record<string, unknown>
      const cached = loadRuleById('rule-soul-fracture-player', false, true) as unknown as Record<string, unknown>

      expect(cold).toMatchObject({
        id: 'rule-soul-fracture-player',
        description: authoredRule.description,
        iconPath,
      })
      expect(cached).toMatchObject({ iconPath })
    } finally {
      clearRuleCache()
      if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
      else process.env.RVB_PROFILE_ROOT = previousRoot
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an authored iconPath through the legacy RuleDefinition converter', () => {
    const rule = convertToTriggerRule({
      id: 'legacy-display-rule',
      name: 'Legacy display rule',
      description: 'Legacy display rule description',
      iconPath: 'images/effect-icons/player-soul-fracture.svg',
      trigger: { type: 'onPieceDied' },
      effect: { type: 'triggerSkill', skillId: 'fireball', message: '触发火球' },
    })

    expect(rule.iconPath).toBe('images/effect-icons/player-soul-fracture.svg')
  })

  it('keeps a hidden rule executable', () => {
    const rule = convertToTriggerRule({
      id: 'legacy-hidden-executable-rule',
      name: 'Hidden executable rule',
      description: 'Hidden from the HUD but still active.',
      visible: false,
      trigger: { type: 'onPieceDied' },
      effect: { type: 'addChargePoints', amount: 2, message: '获得充能' },
    })
    const battle = { players: [{ playerId: 'player-red', chargePoints: 0 }] } as unknown as Parameters<typeof rule.effect>[0]
    const sourcePiece = { ownerPlayerId: 'player-red' }
    const result = rule.effect(battle, { sourcePiece } as Parameters<typeof rule.effect>[1])

    expect(result.success).toBe(true)
    expect(battle.players[0].chargePoints).toBe(2)
  })
})
