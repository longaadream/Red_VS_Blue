/* eslint-disable @typescript-eslint/no-explicit-any -- data-driven fixtures intentionally use runtime shapes */
import { describe, expect, it } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-trace'
import { loadRuleById } from '@/lib/game/skills'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function requiredRule(id: string) {
  const rule = loadRuleById(id, true)
  if (!rule) throw new Error(`Missing RED-80 fixture rule: ${id}`)
  return rule
}

function runRuleStatusFixture(
  fixture: string,
  ruleId: string,
  statusTag: Record<string, unknown>,
  event: Record<string, unknown>,
) {
  const piece = makePiece({ instanceId: `${fixture}-piece`, ownerPlayerId: 'player-red' }) as any
  piece.name = fixture
  piece.statusTags = [statusTag]
  piece.rules = [requiredRule(ruleId)]
  const state = makeState({ pieces: [piece], currentPlayerId: 'player-red' }) as any
  const context = { playerId: 'player-red', sourcePiece: piece, piece, ...event } as any

  const result = new TriggerSystem().checkTriggers(state, context)

  return {
    fixture,
    result: {
      success: result.success,
      blocked: result.blocked,
      messages: result.messages,
    },
    damage: context.damage ?? null,
    statusTypes: piece.statusTags.map((tag: any) => tag.type),
    ruleIds: piece.rules.map((rule: any) => rule.id),
    stateHash: hashBattleState(state),
  }
}

describe('RED-80 Rule + statusTag authority', () => {
  it('freezes representative Rule + statusTag behavior and state hashes after removing AttachedEffect', () => {
    const evidence = [
      runRuleStatusFixture(
        'silenced',
        'rule-silenced-block',
        { id: 'silenced', type: 'silenced' },
        { type: 'beforeSkillUse' },
      ),
      runRuleStatusFixture(
        'freeze',
        'rule-freeze-prevent-move',
        { id: 'freeze', type: 'freeze' },
        { type: 'beforeMove' },
      ),
      runRuleStatusFixture(
        'divine-shield',
        'rule-divine-shield',
        { id: 'divine-shield', type: 'divine-shield' },
        { type: 'beforeDamageTaken', damage: 9 },
      ),
      runRuleStatusFixture(
        'sleep',
        'rule-sleep-prevent-move',
        { id: 'sleep', type: 'sleep' },
        { type: 'beforeMove' },
      ),
      runRuleStatusFixture(
        'watcher-rage',
        'rule-watcher-rage-dealt',
        { id: 'rage', type: 'rage-stance' },
        { type: 'beforeDamageDealt', damage: 3 },
      ),
      runRuleStatusFixture(
        'blood-oath',
        'rule-blood-oath-tick',
        {
          id: 'blood-oath',
          type: 'blood-oath',
          sourcePlayerId: 'player-red',
          remainingTurns: 1,
          remainingDuration: 1,
          currentDuration: 1,
        },
        { type: 'endTurn' },
      ),
    ]

    if (process.env.RED80_RULE_BASELINE === '1') {
      console.info(`[RED-80 rule baseline] ${JSON.stringify(evidence)}`)
    }

    expect(evidence.map(entry => ({
      fixture: entry.fixture,
      blocked: entry.result.blocked,
      damage: entry.damage,
      statusTypes: entry.statusTypes,
      ruleIds: entry.ruleIds,
      stateHash: entry.stateHash,
    }))).toEqual([
      { fixture: 'silenced', blocked: true, damage: null, statusTypes: ['silenced'], ruleIds: ['rule-silenced-block'], stateHash: 'b9100a73f0572db09ab117d6996acb0e7a138fc3eb4f63efdb9a8c2491b29d49' },
      { fixture: 'freeze', blocked: true, damage: null, statusTypes: ['freeze'], ruleIds: ['rule-freeze-prevent-move'], stateHash: 'd323adef5d280060b1421cda440baffa4af6dca232ef937d0b051ff6c392f03b' },
      { fixture: 'divine-shield', blocked: true, damage: 9, statusTypes: [], ruleIds: [], stateHash: '1235a749ff165ff000ef7ccd4c9da1c615a7d915cc7af42273b2dea53258c9cb' },
      { fixture: 'sleep', blocked: true, damage: null, statusTypes: ['sleep'], ruleIds: ['rule-sleep-prevent-move'], stateHash: 'b10bb61b0e19f0bd1a305763d31e4224b6d0b395bf517bd877a8a5f4344bb2fd' },
      { fixture: 'watcher-rage', blocked: false, damage: 6, statusTypes: ['rage-stance'], ruleIds: ['rule-watcher-rage-dealt'], stateHash: '0170d1b8e9ad9875536a5e2862ffcc0c71f5483d31f54f95fb41357d45219446' },
      { fixture: 'blood-oath', blocked: false, damage: null, statusTypes: [], ruleIds: [], stateHash: 'e07b203a91a4adb51cb157b50679476f09c7b2f90d7bc888e225e3ed59f47948' },
    ])
  })
})
