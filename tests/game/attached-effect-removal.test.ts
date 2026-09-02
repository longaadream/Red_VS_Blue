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
      { fixture: 'silenced', blocked: true, damage: null, statusTypes: ['silenced'], ruleIds: ['rule-silenced-block'], stateHash: 'f94d8b3ccc41a508ee2e83eab39fb6aea409dc2dfaa910b2c1ed4a8b2053d8f6' },
      { fixture: 'freeze', blocked: true, damage: null, statusTypes: ['freeze'], ruleIds: ['rule-freeze-prevent-move'], stateHash: '395fb02f25fdd69f5634d83e554c274e04f0700966479bd6bd4b6f6f16b07ed2' },
      { fixture: 'divine-shield', blocked: true, damage: 9, statusTypes: [], ruleIds: [], stateHash: '7a9046418c47f96c0cd4f6df59b001df84a82c31f0bbfe1e11a8af5d8d16097a' },
      { fixture: 'sleep', blocked: true, damage: null, statusTypes: ['sleep'], ruleIds: ['rule-sleep-prevent-move'], stateHash: '1555633d854f487f8325c55252d215553766ebc198b185d34560634e7f394f0d' },
      { fixture: 'watcher-rage', blocked: false, damage: 6, statusTypes: ['rage-stance'], ruleIds: ['rule-watcher-rage-dealt'], stateHash: 'ce1e986a3024fd0f62c64e373cc24a9e3fab47cd97f945845f6e230e1230367f' },
      { fixture: 'blood-oath', blocked: false, damage: null, statusTypes: [], ruleIds: [], stateHash: 'c64901334059db48a7ad59db08d2caa3eb1d4e2bb6bafbdee577ee0c18ae67fd' },
    ])
  })
})
