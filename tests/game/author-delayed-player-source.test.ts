import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '../../lib/skill-graph/module-document'
import { migrateAtomicAuthorGraph } from '../../scripts/migrate-atomic-author-modules'
import { clearRuleCache, executeCardFunction, executeSkillFunction, getRuleDynamicCodeRuntime, loadRuleById, type SkillDefinition } from '../../lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '../../lib/game/rule-runtime'
import { TriggerSystem, globalTriggerSystem } from '../../lib/game/triggers'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

afterEach(() => { clearRuleCache(); getRuleDynamicCodeRuntime().clear(); globalTriggerSystem.clearRules() })

it.each(['alive', 'graveyard', 'removed', 'changed-owner'])('Black Coffin captures its player and keeps delayed logs when caster is %s', mode => {
  const root = mkdtempSync(join(tmpdir(), 'rvb-delayed-source-'))
  const previous = process.env.RVB_PROFILE_ROOT
  const ruleDoc = JSON.parse(readFileSync('data/rules/rule-aizen-black-coffin-end.json', 'utf8'))
  const skillDoc = JSON.parse(readFileSync('data/skills/aizen-black-coffin.json', 'utf8'))
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  writeFileSync(join(root, 'data/rules/rule-aizen-black-coffin-end.json'), JSON.stringify(applyGameplayModuleGraph(ruleDoc, migrateAtomicAuthorGraph(ruleDoc.gameplayModules.entries.skillCode.graph), 'skillCode')))
  const skill = applyGameplayModuleGraph(skillDoc, migrateAtomicAuthorGraph(skillDoc.gameplayModules.entries.code.graph)) as unknown as SkillDefinition
  try {
    process.env.RVB_PROFILE_ROOT = root
    clearRuleCache(); getRuleDynamicCodeRuntime().clear()
    const caster = asPieceInstance(makePiece({ instanceId: 'aizen', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 4 }))
    const victim = asPieceInstance(makePiece({ instanceId: 'victim', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 30, maxHp: 30, defense: 0 }))
    const battle = makeState({ pieces: [caster, victim], turnNumber: 1 })
    const result = withRuleRuntime(new RuleRuntime({ rootSeed: 252, tick: 1 }), () => executeSkillFunction(skill, {
      battle, skill, piece: caster, target: victim, targets: [{ info: victim, pos: { x: 1, y: 0 } }], targetPosition: { x: 1, y: 0 },
    }, battle))
    expect(result.success).toBe(true)
    expect(victim.statusTags).toContainEqual(expect.objectContaining({ type: 'aizen-black-coffin', sourcePlayerId: 'player-red' }))
    expect(battle.actions?.filter(action => action.type === 'damage').at(-1)?.payload).toMatchObject({ damageSource: { kind: 'piece', sourceId: 'aizen' } })
    if (mode === 'changed-owner') caster.ownerPlayerId = 'player-blue'
    if (mode === 'graveyard' || mode === 'removed') {
      battle.pieces = battle.pieces.filter(piece => piece !== caster)
      if (mode === 'graveyard') battle.graveyard = [{ ...caster, currentHp: 0 }]
    }
    battle.turn.turnNumber = 2
    const rule = loadRuleById('rule-aizen-black-coffin-end', true, true)!
    victim.rules = [rule]
    const hp = victim.currentHp
    const tick = new TriggerSystem().checkTriggers(battle, { type: 'endTurn', playerId: 'player-blue' })
    expect(victim.currentHp, JSON.stringify({ tick, actions: battle.actions, tags: victim.statusTags })).toBe(hp - 6)
    const delayedLogs = battle.actions?.filter(action => action.type === 'damage' && action.payload?.skillId === 'aizen-black-coffin-delayed') ?? []
    expect(delayedLogs).toHaveLength(1)
    expect(delayedLogs[0]).toMatchObject({
      playerId: 'player-red',
      payload: {
        sourceId: 'player-red',
        damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
        rawDamage: 6,
        resolvedDamage: 6,
        finalDamage: 6,
        killed: false,
      },
    })
    // A lethal target is already in the graveyard when the rule reaches its
    // id-based status cleanup; the graveyard keeps the historical status tag.
    // The damage log and death classification above are the authoritative
    // assertions for this path.
  } finally {
    if (previous === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['alive', 'graveyard', 'removed', 'changed-owner'])('generated curse retains its creating player when caster is %s', mode => {
  const root = mkdtempSync(join(tmpdir(), 'rvb-curse-player-'))
  const previous = process.env.RVB_PROFILE_ROOT
  for (const [group, id, entry] of [['rules', 'rule-rafaam-curse-ward', 'skillCode'], ['cards', 'rafaam-curse-sample', 'code']] as const) {
    mkdirSync(join(root, 'data', group), { recursive: true })
    const document = JSON.parse(readFileSync(`data/${group}/${id}.json`, 'utf8'))
    writeFileSync(join(root, 'data', group, id + '.json'), JSON.stringify(applyGameplayModuleGraph(document, migrateAtomicAuthorGraph(document.gameplayModules.entries[entry].graph), entry)))
  }
  try {
    process.env.RVB_PROFILE_ROOT = root
    clearRuleCache(); getRuleDynamicCodeRuntime().clear()
    const caster = asPieceInstance(makePiece({ instanceId: 'rafaam', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 8 }))
    const victim = asPieceInstance(makePiece({ instanceId: 'victim', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 30, maxHp: 30 }))
    const battle = makeState({ pieces: [caster, victim] })
    const ward = loadRuleById('rule-rafaam-curse-ward', true, true)!
    const runtime = new RuleRuntime({ rootSeed: 252, tick: 1 })
    withRuleRuntime(runtime, () => ward.effect(battle, { type: 'beforeDamageTaken', rulePiece: caster, sourcePiece: caster, piece: caster, playerId: 'player-red', damage: 0 }))
    const cardInstance = battle.players[1].hand.at(-1)!
    expect(cardInstance).toBeDefined()
    const card = battle.customCards![cardInstance.cardId]
    expect(card.extension).toMatchObject({ sourcePlayerId: 'player-red' })
    expect(card.trigger).toEqual({ type: 'endTurn' })
    if (mode === 'changed-owner') caster.ownerPlayerId = 'player-blue'
    if (mode === 'graveyard' || mode === 'removed') {
      battle.pieces = battle.pieces.filter(piece => piece !== caster)
      if (mode === 'graveyard') battle.graveyard = [{ ...caster, currentHp: 0 }]
    }
    battle.turn.currentPlayerId = 'player-blue'
    const result = withRuleRuntime(runtime, () => executeCardFunction(card, 'player-blue', battle, { type: 'endTurn', playerId: 'player-blue' }, undefined, undefined, undefined, [], cardInstance))
    expect(result.success, JSON.stringify(result)).toBe(true)
    expect(battle.actions?.filter(action => action.type === 'damage').at(-1)?.payload).toMatchObject({ damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' }, resolvedDamage: 4 })
  } finally {
    if (previous === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it('records a lethal delayed Black Coffin as a player-sourced damage log', () => {
  const root = mkdtempSync(join(tmpdir(), 'rvb-delayed-lethal-'))
  const previous = process.env.RVB_PROFILE_ROOT
  const ruleDoc = JSON.parse(readFileSync('data/rules/rule-aizen-black-coffin-end.json', 'utf8'))
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  writeFileSync(join(root, 'data/rules/rule-aizen-black-coffin-end.json'), JSON.stringify(applyGameplayModuleGraph(ruleDoc, migrateAtomicAuthorGraph(ruleDoc.gameplayModules.entries.skillCode.graph), 'skillCode')))
  try {
    process.env.RVB_PROFILE_ROOT = root
    clearRuleCache(); getRuleDynamicCodeRuntime().clear()
    const caster = asPieceInstance(makePiece({ instanceId: 'aizen', ownerPlayerId: 'player-red', x: 0, y: 0 }))
    const victim = asPieceInstance(makePiece({
      instanceId: 'victim', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 1, maxHp: 30,
      statusTags: [{ id: 'coffin-lethal', type: 'aizen-black-coffin', sourceId: 'aizen', sourcePlayerId: 'player-red', delayedDamage: 7 }],
    }))
    const rule = loadRuleById('rule-aizen-black-coffin-end', true, true)!
    victim.rules = [rule]
    const battle = makeState({ pieces: [caster, victim], turnNumber: 2 })
    const tick = new TriggerSystem().checkTriggers(battle, { type: 'endTurn', playerId: 'player-blue' })
    const damageLogs = battle.actions?.filter(action => action.type === 'damage' && action.payload?.skillId === 'aizen-black-coffin-delayed') ?? []
    expect(tick.success).toBe(true)
    expect(victim.currentHp).toBe(0)
    expect(battle.pieces.some(piece => piece.instanceId === 'victim')).toBe(false)
    expect(battle.graveyard.find(piece => piece.instanceId === 'victim')?.currentHp).toBe(0)
    expect(damageLogs).toHaveLength(1)
    expect(damageLogs[0]).toMatchObject({
      playerId: 'player-red',
      payload: {
        targetId: 'victim',
        sourceId: 'player-red',
        damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
        rawDamage: 7,
        resolvedDamage: 7,
        finalDamage: 1,
        killed: true,
      },
    })
    // The graveyard keeps historical status tags after lethal resolution.
  } finally {
    if (previous === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it('resolves multiple lethal Black Coffins independently with the captured player source', () => {
  const root = mkdtempSync(join(tmpdir(), 'rvb-delayed-multi-lethal-'))
  const previous = process.env.RVB_PROFILE_ROOT
  const ruleDoc = JSON.parse(readFileSync('data/rules/rule-aizen-black-coffin-end.json', 'utf8'))
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  writeFileSync(join(root, 'data/rules/rule-aizen-black-coffin-end.json'), JSON.stringify(applyGameplayModuleGraph(ruleDoc, migrateAtomicAuthorGraph(ruleDoc.gameplayModules.entries.skillCode.graph), 'skillCode')))
  try {
    process.env.RVB_PROFILE_ROOT = root
    clearRuleCache(); getRuleDynamicCodeRuntime().clear()
    const caster = asPieceInstance(makePiece({ instanceId: 'aizen', ownerPlayerId: 'player-red', x: 0, y: 0 }))
    const first = asPieceInstance(makePiece({
      instanceId: 'victim-a', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 1, maxHp: 30,
      statusTags: [{ id: 'coffin-a', type: 'aizen-black-coffin', sourceId: 'aizen', sourcePlayerId: 'player-red', delayedDamage: 7 }],
    }))
    const second = asPieceInstance(makePiece({
      instanceId: 'victim-b', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 1, maxHp: 30,
      statusTags: [{ id: 'coffin-b', type: 'aizen-black-coffin', sourceId: 'aizen', sourcePlayerId: 'player-red', delayedDamage: 4 }],
    }))
    first.rules = [loadRuleById('rule-aizen-black-coffin-end', true, true)!]
    second.rules = [loadRuleById('rule-aizen-black-coffin-end', true, true)!]
    const battle = makeState({ pieces: [caster, first, second], turnNumber: 2 })
    const tick = new TriggerSystem().checkTriggers(battle, { type: 'endTurn', playerId: 'player-blue' })
    const damageLogs = battle.actions?.filter(action => action.type === 'damage' && action.payload?.skillId === 'aizen-black-coffin-delayed') ?? []
    expect(tick.success).toBe(true)
    expect(damageLogs).toHaveLength(2)
    expect(damageLogs.map(action => action.payload?.targetId)).toEqual(['victim-a', 'victim-b'])
    for (const [index, log] of damageLogs.entries()) {
      expect(log).toMatchObject({
        playerId: 'player-red',
        payload: {
          sourceId: 'player-red',
          damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
          rawDamage: index === 0 ? 7 : 4,
          resolvedDamage: index === 0 ? 7 : 4,
          finalDamage: 1,
          killed: true,
        },
      })
    }
    expect(battle.pieces.map(piece => piece.instanceId)).toEqual(['aizen'])
    expect(battle.graveyard.map(piece => piece.instanceId).sort()).toEqual(['victim-a', 'victim-b'])
    // Both targets are graveyard history after lethal damage; their status
    // tags are retained there by the existing death lifecycle.
  } finally {
    if (previous === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it('skips a missing sourcePlayerId while cleaning the other Black Coffin records', () => {
  const root = mkdtempSync(join(tmpdir(), 'rvb-delayed-missing-player-'))
  const previous = process.env.RVB_PROFILE_ROOT
  const ruleDoc = JSON.parse(readFileSync('data/rules/rule-aizen-black-coffin-end.json', 'utf8'))
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  writeFileSync(join(root, 'data/rules/rule-aizen-black-coffin-end.json'), JSON.stringify(applyGameplayModuleGraph(ruleDoc, migrateAtomicAuthorGraph(ruleDoc.gameplayModules.entries.skillCode.graph), 'skillCode')))
  try {
    process.env.RVB_PROFILE_ROOT = root
    clearRuleCache(); getRuleDynamicCodeRuntime().clear()
    const victim = asPieceInstance(makePiece({
      instanceId: 'victim', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 30, maxHp: 30,
      statusTags: [
        { id: 'coffin-valid', type: 'aizen-black-coffin', sourceId: 'aizen', sourcePlayerId: 'player-red', delayedDamage: 4 },
        { id: 'coffin-missing-player', type: 'aizen-black-coffin', sourceId: 'aizen', delayedDamage: 9 },
      ],
    }))
    victim.rules = [loadRuleById('rule-aizen-black-coffin-end', true, true)!]
    const battle = makeState({ pieces: [victim], turnNumber: 2 })
    const tick = new TriggerSystem().checkTriggers(battle, { type: 'endTurn', playerId: 'player-blue' })
    const damageLogs = battle.actions?.filter(action => action.type === 'damage' && action.payload?.skillId === 'aizen-black-coffin-delayed') ?? []
    expect(victim.currentHp).toBe(26)
    expect(damageLogs).toHaveLength(1)
    expect(damageLogs[0]).toMatchObject({
      playerId: 'player-red',
      payload: {
        sourceId: 'player-red',
        damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
        rawDamage: 4,
        finalDamage: 4,
        killed: false,
      },
    })
    expect(tick.messages).toEqual(['黑棺终结，对test-piece造成4点魔法伤害'])
    expect(victim.statusTags.some(tag => tag.type === 'aizen-black-coffin')).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})
