/* eslint-disable @typescript-eslint/no-explicit-any -- regression fixtures intentionally use event-shaped contexts. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'
import { buildDeathSummonRuleGraph, DEATH_SUMMON_RULE_IDS } from '@/scripts/migrate-semantic-death-summon-rules'
import { buildMeteorGuardGraph } from '@/scripts/migrate-semantic-meteor-guard'
import { buildPlayerProtectionRuleGraph } from '@/scripts/migrate-semantic-player-protection-rules'
import { buildRecoveryRuleGraph } from '@/scripts/migrate-semantic-recovery-rules'
import { buildStatusEventGraph, STATUS_EVENT_RECIPES } from '@/scripts/migrate-semantic-status-events'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, JsonRecord>
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function runRule<T>(id: string, document: JsonRecord, callback: (rule: any) => T, extraDocuments: Record<string, JsonRecord> = {}): T {
  const root = mkdtempSync(join(tmpdir(), 'rvb-atomic-missing-subject-'))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  writeFileSync(join(root, 'data/rules', `${id}.json`), JSON.stringify(document), 'utf8')
  for (const [extraId, extra] of Object.entries(extraDocuments)) writeFileSync(join(root, 'data/rules', `${extraId}.json`), JSON.stringify(extra), 'utf8')
  try {
    process.env.RVB_PROFILE_ROOT = root
    clearRuleCache()
    const rule = loadRuleById(id, true, true)
    if (!rule) throw new Error(`rule did not load: ${id}`)
    return callback(rule)
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function generatedRule(id: string, graph: any): JsonRecord {
  const source = fixture[`rules/${id}`]
  if (!source) throw new Error(`missing frozen fixture entry rules/${id}`)
  return applyGameplayModuleGraph(copy(source), graph, 'skillCode') as JsonRecord
}

function eventContext(id: string, overrides: JsonRecord = {}): JsonRecord {
  return { type: fixture[`rules/${id}`].trigger.type, rulePiece: overrides.rulePiece, piece: null, sourcePiece: null, playerId: 'player-red', ...overrides }
}

describe('atomic migration keeps missing event subjects inert', () => {
  for (const id of DEATH_SUMMON_RULE_IDS) {
    it(`${id} does not return a summon profile without event subject`, () => {
      const holder = asPieceInstance(makePiece({
        instanceId: 'holder', ownerPlayerId: 'player-blue', x: 2, y: 2, currentHp: 0, maxHp: 20,
        statusTags: [{ id: 'covenant', type: id === 'rule-arthas-lich-covenant' ? 'lich-covenant' : 'other' }],
        skills: [{ skillId: 'fireball', currentCooldown: 3, usesRemaining: 1 }],
      })) as any
      holder.rules = [{ id }]
      const attacker = asPieceInstance(makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-red', x: 1, y: 2 })) as any
      const state: any = makeState({ pieces: [holder, attacker] })
      const before = copy({ pieces: state.pieces, graveyard: state.graveyard })

      const result = runRule(id, generatedRule(id, buildDeathSummonRuleGraph(id)), rule => rule.effect(
        state,
        eventContext(id, { rulePiece: holder, piece: null, sourcePiece: null }),
      ))

      expect(result).not.toHaveProperty('summonAfterDeath')
      expect({ pieces: state.pieces, graveyard: state.graveyard }).toEqual(before)
    })
  }

  it('rule-el-primo-meteor-belt does not enqueue a redirect without event subject', () => {
    const guard = asPieceInstance(makePiece({
      instanceId: 'guard', ownerPlayerId: 'player-red', x: 2, y: 1, currentHp: 100,
      statusTags: [{ id: 'belt', type: 'el-primo-meteor-belt', currentDuration: -1 }],
    })) as any
    const attacker = asPieceInstance(makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-blue', x: 4, y: 4 })) as any
    const state: any = makeState({ pieces: [attacker, guard] })
    const queued: string[] = []
    const context = eventContext('rule-el-primo-meteor-belt', {
      rulePiece: guard,
      sourcePiece: attacker,
      damage: 8,
      damageRedirectQueue: { push: ({ target }: any) => { queued.push(target.instanceId); return true } },
    })
    const before = copy({ pieces: state.pieces, graveyard: state.graveyard })

    runRule('rule-el-primo-meteor-belt', generatedRule('rule-el-primo-meteor-belt', buildMeteorGuardGraph()), rule => rule.effect(state, context))

    expect(queued).toEqual([])
    expect({ pieces: state.pieces, graveyard: state.graveyard }).toEqual(before)
  })

  it('rule-elune-protection-player does not consume the shared protection without event subject', () => {
    const holder = asPieceInstance(makePiece({ instanceId: 'holder', ownerPlayerId: 'player-red', currentHp: 8, maxHp: 10 })) as any
    const state: any = makeState({ pieces: [holder] })
    state.players[0].statusTags = [
      { id: 'first', type: 'elune-protection' },
      { id: 'second', type: 'elune-protection' },
      { id: 'keep', type: 'other' },
    ]
    const before = copy(state.players[0].statusTags)

    runRule('rule-elune-protection-player', generatedRule('rule-elune-protection-player', buildPlayerProtectionRuleGraph('rule-elune-protection-player')), rule => rule.effect(
      state,
      eventContext('rule-elune-protection-player', { rulePiece: holder, sourcePiece: holder, piece: null, damage: 8 }),
    ))

    expect(state.players[0].statusTags).toEqual(before)
    expect(holder.currentHp).toBe(8)
  })

  it('rule-shelly-bandage does not heal or spend the ability without event subject', () => {
    const holder = asPieceInstance(makePiece({ instanceId: 'holder', ownerPlayerId: 'player-red', currentHp: 0.5, maxHp: 10 })) as any
    holder.spentPassives = []
    const state: any = makeState({ pieces: [holder] })
    const context = eventContext('rule-shelly-bandage', { rulePiece: holder, damage: 1, heal: 1 })
    const before = { hp: holder.currentHp, tags: copy(holder.statusTags), spent: copy(holder.spentPassives), damage: context.damage, heal: context.heal }

    runRule('rule-shelly-bandage', generatedRule('rule-shelly-bandage', buildRecoveryRuleGraph('rule-shelly-bandage')), rule => rule.effect(state, context))

    expect({ hp: holder.currentHp, tags: holder.statusTags, spent: holder.spentPassives, damage: context.damage, heal: context.heal }).toEqual(before)
  })

  it('rule-tirion-divine-shield-start does not apply a shield without event subject', () => {
    const holder = asPieceInstance(makePiece({ instanceId: 'holder', ownerPlayerId: 'player-red', currentHp: 10, maxHp: 20 })) as any
    holder.rules = []
    const state: any = makeState({ pieces: [holder] })
    const before = copy({ tags: holder.statusTags, rules: holder.rules })

    runRule('rule-tirion-divine-shield-start', generatedRule('rule-tirion-divine-shield-start', buildRecoveryRuleGraph('rule-tirion-divine-shield-start')), rule => rule.effect(
      state,
      eventContext('rule-tirion-divine-shield-start', { rulePiece: holder, sourcePiece: null, piece: null }),
    ), { 'rule-divine-shield': fixture['rules/rule-divine-shield'] })

    expect({ tags: holder.statusTags, rules: holder.rules }).toEqual(before)
  })

  for (const id of ['rule-divine-shield', 'rule-naruto-sage-immunity'] as const) {
    it(`${id} does not consume status or rule without event subject`, () => {
      const recipe = STATUS_EVENT_RECIPES[id]
      const holder = asPieceInstance(makePiece({
        instanceId: 'holder', ownerPlayerId: 'player-red', currentHp: 10, maxHp: 20,
        statusTags: [{ id: 'first', type: recipe.status }, { id: 'second', type: recipe.status }],
      })) as any
      const state: any = makeState({ pieces: [holder] })
      holder.rules = [{ id }]
      const context = eventContext(id, { rulePiece: holder, piece: null, sourcePiece: null, damage: 3 })
      const before = copy({ tags: holder.statusTags, rules: holder.rules, damage: context.damage })

      runRule(id, generatedRule(id, buildStatusEventGraph(id)), rule => rule.effect(state, context))

      expect({ tags: holder.statusTags, rules: holder.rules, damage: context.damage }).toEqual(before)
    })
  }

  for (const id of ['rule-watcher-rage-dealt', 'rule-watcher-rage-taken'] as const) {
    it(`${id} does not modify damage without event subject`, () => {
      const recipe = STATUS_EVENT_RECIPES[id]
      const holder = asPieceInstance(makePiece({
        instanceId: 'holder', ownerPlayerId: 'player-red', currentHp: 10, maxHp: 20,
        statusTags: [{ id: 'rage', type: recipe.status }],
      })) as any
      const state: any = makeState({ pieces: [holder] })
      const context = eventContext(id, { rulePiece: holder, piece: null, sourcePiece: null, damage: -2 })

      runRule(id, generatedRule(id, buildStatusEventGraph(id)), rule => rule.effect(state, context))

      expect(context.damage).toBe(-2)
    })
  }
})
