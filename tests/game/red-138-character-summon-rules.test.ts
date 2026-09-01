/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures exercise JSON-authored RED-138 rules. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function loadRule(id: string) {
  const loaded = loadRuleById(id, true)
  if (!loaded) throw new Error(`${id} did not load`)
  return loaded
}

function namedPiece(overrides: Parameters<typeof makePiece>[0], name: string) {
  const piece = makePiece(overrides) as any
  piece.name = name
  return piece
}

function fire(state: BattleState, type: 'gameStart' | 'afterPieceSummoned', sourcePiece?: any) {
  return globalTriggerSystem.checkTriggers(state, {
    type,
    playerId: sourcePiece?.ownerPlayerId ?? 'player-red',
    sourcePiece,
    turnNumber: 1,
  } as any)
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED-138 角色召唤触发', () => {
  it('泰兰德只在本人被召唤时补充共享守护，未消耗时不会叠加', () => {
    const tyrande = namedPiece({
      instanceId: 'tyrande',
      templateId: 'tyrande',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
    }, '泰兰德')
    tyrande.rules = [loadRule('rule-elune-protection')]
    const ally = namedPiece({
      instanceId: 'ally',
      ownerPlayerId: 'player-red',
      x: 2,
      y: 1,
    }, '友军')
    const state = makeState({ pieces: [tyrande, ally] }) as any
    const player = state.players.find((candidate: any) => candidate.playerId === 'player-red')

    expect(fire(state, 'gameStart').success).toBe(false)
    expect(fire(state, 'afterPieceSummoned', ally).success).toBe(false)
    expect(player.statusTags || []).not.toContainEqual(expect.objectContaining({ type: 'elune-protection' }))

    expect(fire(state, 'afterPieceSummoned', tyrande).success).toBe(true)
    expect(player.statusTags.filter((tag: any) => tag.type === 'elune-protection')).toHaveLength(1)
    expect(player.rules.filter((rule: any) => rule.id === 'rule-elune-protection-player')).toHaveLength(1)

    expect(fire(state, 'afterPieceSummoned', tyrande).success).toBe(false)
    expect(player.statusTags.filter((tag: any) => tag.type === 'elune-protection')).toHaveLength(1)
    expect(player.rules.filter((rule: any) => rule.id === 'rule-elune-protection-player')).toHaveLength(1)

    player.statusTags = player.statusTags.filter((tag: any) => tag.type !== 'elune-protection')
    player.rules = player.rules.filter((rule: any) => rule.id !== 'rule-elune-protection-player')
    expect(fire(state, 'afterPieceSummoned', tyrande).success).toBe(true)
    expect(player.statusTags.filter((tag: any) => tag.type === 'elune-protection')).toHaveLength(1)
    expect(player.rules.filter((rule: any) => rule.id === 'rule-elune-protection-player')).toHaveLength(1)
  })

  it('提里奥只在本人被召唤时补充圣盾，已有圣盾与规则不会叠加', () => {
    const tirion = namedPiece({
      instanceId: 'tirion',
      templateId: 'blue-tirion-fordring',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
    }, '提里奥弗丁')
    tirion.rules = [loadRule('rule-tirion-divine-shield-start')]
    const ally = namedPiece({
      instanceId: 'ally',
      ownerPlayerId: 'player-red',
      x: 2,
      y: 1,
    }, '友军')
    const state = makeState({ pieces: [tirion, ally] }) as any

    expect(fire(state, 'gameStart').success).toBe(false)
    expect(fire(state, 'afterPieceSummoned', ally).success).toBe(false)
    expect(tirion.statusTags).not.toContainEqual(expect.objectContaining({ type: 'divine-shield' }))

    expect(fire(state, 'afterPieceSummoned', tirion).success).toBe(true)
    expect(tirion.statusTags.filter((tag: any) => tag.type === 'divine-shield')).toHaveLength(1)
    expect(tirion.rules.filter((rule: any) => rule.id === 'rule-divine-shield')).toHaveLength(1)

    expect(fire(state, 'afterPieceSummoned', tirion).success).toBe(false)
    expect(tirion.statusTags.filter((tag: any) => tag.type === 'divine-shield')).toHaveLength(1)
    expect(tirion.rules.filter((rule: any) => rule.id === 'rule-divine-shield')).toHaveLength(1)

    tirion.statusTags = tirion.statusTags.filter((tag: any) => tag.type !== 'divine-shield')
    tirion.rules = tirion.rules.filter((rule: any) => rule.id !== 'rule-divine-shield')
    expect(fire(state, 'afterPieceSummoned', tirion).success).toBe(true)
    expect(tirion.statusTags.filter((tag: any) => tag.type === 'divine-shield')).toHaveLength(1)
    expect(tirion.rules.filter((rule: any) => rule.id === 'rule-divine-shield')).toHaveLength(1)
  })
})
