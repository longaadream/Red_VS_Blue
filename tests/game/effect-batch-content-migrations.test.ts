/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures exercise serialized content and trigger contracts. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { aiEnvironmentV1, listLegalAIActions } from '@/lib/game/ai-environment'
import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import { dealDamage, loadRuleById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 0x8b0139

function requiredRule(id: string) {
  const rule = loadRuleById(id, true)
  if (!rule) throw new Error('Missing RED-139 fixture rule: ' + id)
  return rule
}

function eventRule(id: string, type: string, effect: (battle: any, context: any) => void) {
  return {
    id,
    name: id,
    description: '',
    trigger: { type },
    effect: (battle: any, context: any) => {
      effect(battle, context)
      return { success: true }
    },
  }
}

function loadJson(path: string) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

function withTargetCredentials(state: BattleState, action: Record<string, any>) {
  const draft = { ...action }
  delete draft.targetPieceId
  delete draft.targetX
  delete draft.targetY
  delete draft.extraTargets
  const prepared = prepareAction(state, draft as any)
  if (prepared.kind !== 'needTarget') {
    throw new Error('Expected target preparation, received ' + prepared.kind)
  }
  return {
    ...action,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

function makeNarutoState() {
  const sentinelBefore = makePiece({
    instanceId: 'sentinel-before', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 4,
  }) as any
  const naruto = makePiece({
    instanceId: 'naruto', templateId: 'red-naruto', ownerPlayerId: 'player-red', faction: 'red',
    x: 1, y: 1, currentHp: 67, maxHp: 123, attack: 11, moveRange: 5,
  }) as any
  naruto.name = '鸣人'
  naruto.defense = 4
  naruto.skills = [
    { skillId: 'naruto-shadow-clone', level: 1, currentCooldown: 0, usesRemaining: -1 },
    { skillId: 'display-only-skill', level: 2, currentCooldown: 1, usesRemaining: 3 },
  ]
  naruto.statusTags = [
    { id: 'visible-tag', type: 'visible-fixture', name: 'Visible', visible: true, intensity: 2 },
    { id: 'hidden-tag', type: 'hidden-fixture', name: 'Hidden', visible: false, intensity: 9 },
  ]
  const sentinelAfter = makePiece({
    instanceId: 'sentinel-after', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 4,
  }) as any
  const state = makeState({ pieces: [sentinelBefore, naruto, sentinelAfter], width: 6, height: 5 }) as any
  state.players[0].actionPoints = 10
  state.skillsById['naruto-shadow-clone'] = loadJson('data/skills/naruto-shadow-clone.json')
  state.skillsById['display-only-skill'] = {
    id: 'display-only-skill',
    name: 'Display-only passive fixture',
    description: '',
    kind: 'passive',
    type: 'normal',
  }
  return { naruto, state }
}

function makeDemonState(withStoredKiljaedan: boolean, anchorHp = 20) {
  const anchor = makePiece({
    instanceId: 'demon-anchor', templateId: 'red-anchor', ownerPlayerId: 'player-red', faction: 'red',
    x: 0, y: 0, currentHp: anchorHp, maxHp: 20, attack: 3,
  }) as any
  anchor.name = '献祭者'
  const state = makeState({ pieces: [anchor], currentPlayerId: 'player-red', phase: 'action' }) as any
  const red = state.players.find((player: any) => player.playerId === 'player-red')
  red.hand = [{ cardId: 'demon-summon-5', instanceId: 'demon-card-5', actionPointCost: 3 }]
  red.discardPile = []
  red.actionPoints = 3
  if (withStoredKiljaedan) {
    state.extensions.kiljaedanPiece = {
      instanceId: 'kiljaedan-hidden',
      templateId: 'kiljaedan',
      name: '基尔加丹',
      ownerPlayerId: 'player-red',
      faction: 'red',
      currentHp: 1,
      maxHp: 17,
      attack: 4,
      defense: 3,
      moveRange: 4,
      x: 0,
      y: 0,
      skills: [{ skillId: 'kiljaedan-fel-fire', level: 1, currentCooldown: 0 }],
      displaySkills: [{ skillId: 'kiljaedan-fel-fire', level: 1, currentCooldown: 0 }],
      rules: [],
      statusTags: [{ id: 'stored-status', type: 'stored-status', visible: true }],
    }
  }
  const action = withTargetCredentials(state, {
    type: 'playCard',
    playerId: 'player-red',
    cardInstanceId: 'demon-card-5',
    clientActionId: withStoredKiljaedan ? 'red139-demon-restore' : 'red139-demon-create',
    targetPieceId: anchor.instanceId,
    targetX: anchor.x,
    targetY: anchor.y,
    extraTargets: [{ x: 2, y: 2 }],
  })
  return { action, anchor, state }
}

describe('RED-139 approved content migrations', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it('queues Reap healing until the endogenous DeathBatch has finalized and keeps the approved message', () => {
    const reaper = makePiece({
      instanceId: 'reaper', ownerPlayerId: 'player-red', faction: 'red',
      currentHp: 4, maxHp: 10, attack: 6,
    }) as any
    reaper.name = '刈命者'
    reaper.rules = [requiredRule('rule-reap')]
    const victim = makePiece({
      instanceId: 'reap-victim', ownerPlayerId: 'player-blue', faction: 'blue',
      currentHp: 5, maxHp: 5,
    }) as any
    victim.name = '牺牲者'
    const state = makeState({ pieces: [reaper, victim] }) as any
    const lifecycle: string[] = []
    const healSnapshots: Array<Record<string, unknown>> = []
    globalTriggerSystem.addRules([
      eventRule('observe-reap-killed', 'afterPieceKilled', (_battle, context) => {
        if (context.targetPiece?.instanceId === victim.instanceId) lifecycle.push('afterPieceKilled')
      }),
      eventRule('observe-reap-died', 'onPieceDied', (_battle, context) => {
        if (context.sourcePiece?.instanceId === victim.instanceId) lifecycle.push('onPieceDied')
      }),
      eventRule('observe-reap-heal-window', 'beforeHealTaken', (battle, context) => {
        if (context.targetPiece?.instanceId !== reaper.instanceId) return
        lifecycle.push('beforeHealTaken')
        healSnapshots.push({
          victimOnBoard: battle.pieces.some((piece: any) => piece.instanceId === victim.instanceId),
          victimInGraveyard: battle.graveyard.some((piece: any) => piece.instanceId === victim.instanceId),
          redCharge: battle.players.find((player: any) => player.playerId === 'player-red')?.chargePoints,
          effectBatchKind: context.effectBatchKind,
        })
      }),
    ] as any)

    dealDamage(reaper, victim, 6, 'true', state, 'red139-reap-lethal')

    expect(lifecycle).toEqual(['afterPieceKilled', 'onPieceDied', 'beforeHealTaken'])
    expect(healSnapshots).toEqual([{
      victimOnBoard: false,
      victimInGraveyard: true,
      redCharge: 0,
      effectBatchKind: 'heal',
    }])
    expect(reaper.currentHp).toBe(7)
    expect(state.actions
      .filter((action: any) => action.type === 'triggerEffect')
      .map((action: any) => action.payload?.message))
      .toContain('刈命者触发了收割')
  })

  it('summons a complete sealed Naruto clone through the real AI action runner with peer-stable hashes', () => {
    const firstFixture = makeNarutoState()
    const secondState = structuredClone(firstFixture.state)
    const candidate = listLegalAIActions(firstFixture.state, 'player-red').find(item => (
      item.kind === 'basic-skill' &&
      item.action.type === 'useBasicSkill' &&
      item.action.skillId === 'naruto-shadow-clone' &&
      item.action.selectedOption === 'summon' &&
      item.action.targetX === 2 &&
      item.action.targetY === 1
    ))
    expect(candidate).toBeDefined()
    if (!candidate) return

    const authority = aiEnvironmentV1.simulate(firstFixture.state, candidate, { rootSeed: ROOT_SEED })
    const peer = aiEnvironmentV1.simulate(secondState, candidate, { rootSeed: ROOT_SEED })

    expect(authority.accepted).toBe(true)
    expect(peer.accepted).toBe(true)
    if (!authority.accepted || !peer.accepted) return
    expect(authority.stateHash).toBe(peer.stateHash)
    expect(authority.transitionHash).toBe(peer.transitionHash)

    const clone = authority.state.pieces.find(piece => piece.instanceId.startsWith('naruto-clone-')) as any
    const peerClone = peer.state.pieces.find(piece => piece.instanceId.startsWith('naruto-clone-')) as any
    expect(clone).toBeDefined()
    expect(peerClone?.instanceId).toBe(clone.instanceId)
    expect(clone).toMatchObject({
      templateId: 'red-naruto',
      name: '鸣人',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 2,
      y: 1,
      maxHp: 99,
      currentHp: 99,
      displayMaxHp: 123,
      displayCurrentHp: 67,
      displayAttack: 11,
      displayDefense: 4,
      displayMoveRange: 5,
      attack: 0,
      defense: 0,
      moveRange: 0,
      masterPieceId: 'naruto',
      noKillCharge: true,
      skills: [],
      buffs: [],
      debuffs: [],
      ruleTags: [],
    })
    expect(clone.displaySkills).toEqual(firstFixture.naruto.skills)
    expect(clone.displayStatusTags).toEqual([firstFixture.naruto.statusTags[0]])
    expect(clone.rules.map((rule: any) => rule.id).sort()).toEqual([
      'rule-naruto-clone-died',
      'rule-naruto-clone-immobile',
      'rule-naruto-clone-one-hit',
    ])
    expect(clone.statusTags).toEqual([
      expect.objectContaining({
        type: 'naruto-clone',
        visible: false,
        relatedRules: [
          'rule-naruto-clone-died',
          'rule-naruto-clone-immobile',
          'rule-naruto-clone-one-hit',
        ],
      }),
    ])
    const casterIndex = authority.state.pieces.findIndex(piece => piece.instanceId === 'naruto')
    const cloneIndex = authority.state.pieces.findIndex(piece => piece.instanceId === clone.instanceId)
    expect(Math.abs(casterIndex - cloneIndex)).toBe(1)
  })

  it('accepts both declared summon recipes when PlayerTurnMeta omits the non-schema faction field', () => {
    const narutoFixture = makeNarutoState()
    for (const player of narutoFixture.state.players as any[]) delete player.faction
    const candidate = listLegalAIActions(narutoFixture.state, 'player-red').find(item => (
      item.kind === 'basic-skill'
      && item.action.type === 'useBasicSkill'
      && item.action.skillId === 'naruto-shadow-clone'
      && item.action.selectedOption === 'summon'
      && item.action.targetX === 2
      && item.action.targetY === 1
    ))
    expect(candidate).toBeDefined()
    if (!candidate) return

    const narutoResult = aiEnvironmentV1.simulate(
      narutoFixture.state,
      candidate,
      { rootSeed: ROOT_SEED },
    )
    expect(narutoResult.accepted).toBe(true)
    if (!narutoResult.accepted) return
    expect(narutoResult.state.pieces.some(piece => piece.instanceId.startsWith('naruto-clone-'))).toBe(true)

    const demonFixture = makeDemonState(false)
    for (const player of demonFixture.state.players as any[]) delete player.faction
    const demonResult = runBattleAction(
      demonFixture.state,
      demonFixture.action as any,
      { rootSeed: ROOT_SEED },
    )
    expect(demonResult.state.pieces.find(piece => piece.templateId === 'kiljaedan')).toMatchObject({
      ownerPlayerId: 'player-red', faction: 'red', x: 2, y: 2,
    })
  })

  it('runs real demon-summon-5 as damage then attack gain then SummonBatch and deletes storage only at commit', () => {
    const firstFixture = makeDemonState(true)
    const peerState = structuredClone(firstFixture.state)
    const observations: Array<Record<string, unknown>> = []
    globalTriggerSystem.addRules([
      eventRule('observe-demon-before-summon', 'beforePieceSummoned', (battle, context) => {
        if (context.sourcePiece?.templateId !== 'kiljaedan') return
        const anchor = battle.pieces.find((piece: any) => piece.instanceId === 'demon-anchor')
        observations.push({
          stage: 'before',
          anchorHp: anchor?.currentHp,
          anchorAttack: anchor?.attack,
          extensionPresent: !!battle.extensions.kiljaedanPiece,
          kiljaedanOnBoard: battle.pieces.some((piece: any) => piece.templateId === 'kiljaedan'),
          effectBatchKind: context.effectBatchKind,
        })
      }),
      eventRule('observe-demon-after-summon', 'afterPieceSummoned', (battle, context) => {
        if (context.sourcePiece?.templateId !== 'kiljaedan') return
        const anchor = battle.pieces.find((piece: any) => piece.instanceId === 'demon-anchor')
        observations.push({
          stage: 'after',
          anchorHp: anchor?.currentHp,
          anchorAttack: anchor?.attack,
          extensionPresent: !!battle.extensions.kiljaedanPiece,
          kiljaedanOnBoard: battle.pieces.some((piece: any) => piece.templateId === 'kiljaedan'),
          effectBatchKind: context.effectBatchKind,
        })
      }),
    ] as any)

    const authority = runBattleAction(firstFixture.state, firstFixture.action as any, { rootSeed: ROOT_SEED })
    const peer = runBattleAction(peerState, firstFixture.action as any, { rootSeed: ROOT_SEED })

    expect(authority.stateHash).toBe(peer.stateHash)
    const expectedWindows = [
      {
        stage: 'before', anchorHp: 14, anchorAttack: 4,
        extensionPresent: true, kiljaedanOnBoard: false, effectBatchKind: 'summon',
      },
      {
        stage: 'after', anchorHp: 14, anchorAttack: 4,
        extensionPresent: false, kiljaedanOnBoard: true, effectBatchKind: 'summon',
      },
    ]
    expect(observations.slice(0, 2)).toEqual(expectedWindows)
    expect(observations.slice(2, 4)).toEqual(expectedWindows)
    expect((authority.state as any).extensions.kiljaedanPiece).toBeUndefined()
    expect(authority.state.pieces.find(piece => piece.instanceId === 'kiljaedan-hidden')).toMatchObject({
      x: 2,
      y: 2,
      currentHp: 17,
      statusTags: [{ id: 'stored-status', type: 'stored-status', visible: true }],
    })
  })
  it.each([true, false])(
    'preserves demon-summon-5 when lethal ritual damage finalizes its source (stored=%s)',
    withStoredKiljaedan => {
      const fixture = makeDemonState(withStoredKiljaedan, 6)
      const result = runBattleAction(fixture.state, fixture.action as any, { rootSeed: ROOT_SEED })
      const red = result.state.players.find(player => player.playerId === 'player-red') as any
      const sacrificed = result.state.graveyard.find(piece => piece.instanceId === 'demon-anchor') as any
      const summoned = result.state.pieces.find(piece => piece.templateId === 'kiljaedan') as any

      expect(result.state.pieces.some(piece => piece.instanceId === 'demon-anchor')).toBe(false)
      expect(sacrificed).toMatchObject({ currentHp: 0, attack: 4, ownerPlayerId: 'player-red' })
      expect(summoned).toMatchObject({ ownerPlayerId: 'player-red', currentHp: 17, x: 2, y: 2 })
      expect((result.state as any).extensions.kiljaedanPiece).toBeUndefined()
      expect(red).toMatchObject({ actionPoints: 0, hand: [], discardPile: ['demon-summon-5'] })
    },
  )

  it('isolates the declared before-summon view while still accepting target-position redirects', () => {
    const fixture = makeDemonState(true)
    globalTriggerSystem.addRule(eventRule(
      'attempt-to-forge-sealed-demon-summon',
      'beforePieceSummoned',
      (_battle, context) => {
        if (context.sourcePiece?.templateId !== 'kiljaedan') return
        context.sourcePiece.instanceId = 'forged-by-before-rule'
        context.sourcePiece.ownerPlayerId = 'player-blue'
        context.sourcePiece.attack = 999
        context.sourcePiece.rules = [{ id: 'arbitrary-injected-rule' }]
        context.targetPosition = { x: 3, y: 2 }
      },
    ) as any)

    const result = runBattleAction(fixture.state, fixture.action as any, { rootSeed: ROOT_SEED })
    const summoned = result.state.pieces.find(piece => piece.instanceId === 'kiljaedan-hidden') as any

    expect(result.state.pieces.some(piece => piece.instanceId === 'forged-by-before-rule')).toBe(false)
    expect(summoned).toMatchObject({
      ownerPlayerId: 'player-red',
      attack: 4,
      x: 3,
      y: 2,
      rules: [],
    })
    expect(summoned.rules.some((rule: any) => rule.id === 'arbitrary-injected-rule')).toBe(false)
  })

  it('rejects a redirected summon outside explicit map bounds even when a stray tile exists', () => {
    const fixture = makeDemonState(true)
    fixture.state.map.width = 3
    fixture.state.map.height = 3
    fixture.state.map.tiles.push({
      x: 99,
      y: 99,
      props: { type: 'floor', walkable: true, isSpawn: false, isHole: false, isCover: false },
    })
    globalTriggerSystem.addRule(eventRule(
      'redirect-sealed-demon-outside-map',
      'beforePieceSummoned',
      (_battle, context) => {
        if (context.sourcePiece?.templateId === 'kiljaedan') {
          context.targetPosition = { x: 99, y: 99 }
        }
      },
    ) as any)
    const before = JSON.stringify(fixture.state)

    let caught: unknown
    try {
      runBattleAction(fixture.state, fixture.action as any, { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: expect.objectContaining({ kind: 'summon', detached: false }),
    })
    expect(JSON.stringify(fixture.state)).toBe(before)
  })


  it.each([
    {
      name: 'NaN HP',
      mutateCode: 'caster.currentHp = 0 / 0;',
      message: 'not an active living piece',
    },
    {
      name: 'infinite HP',
      mutateCode: 'caster.currentHp = 1 / 0;',
      message: 'not an active living piece',
    },
    {
      name: 'undefined HP',
      mutateCode: 'delete caster.currentHp;',
      message: 'not an active living piece',
    },
    {
      name: 'duplicate canonical source',
      mutateCode: 'context.battle.graveyard.push(Object.assign({}, caster, { currentHp: 0 }));',
      message: 'one canonical piece',
    },
    {
      name: 'missing owner',
      mutateCode: 'context.battle.players = context.battle.players.filter(function(player) { return player.playerId !== caster.ownerPlayerId; });',
      message: 'owner player was not found',
    },
    {
      name: 'invalid optional owner faction',
      mutateCode: "context.battle.players.find(function(player) { return player.playerId === caster.ownerPlayerId; }).faction = 'green';",
      message: 'owner faction must be red or blue when present',
    },
    {
      name: 'invalid faction',
      mutateCode: "caster.faction = 'green';",
      message: 'source faction must be red or blue',
    },
    {
      name: 'owner faction mismatch',
      mutateCode: "caster.faction = 'blue';",
      message: 'source faction does not match its owner player',
    },
  ])('rejects source-mirror $name inside the authoritative root and rolls back', ({
    name,
    mutateCode,
    message,
  }) => {
    const fixture = makeNarutoState()
    const candidate = listLegalAIActions(fixture.state, 'player-red').find(item => (
      item.kind === 'basic-skill'
      && item.action.type === 'useBasicSkill'
      && item.action.skillId === 'naruto-shadow-clone'
      && item.action.selectedOption === 'summon'
      && item.action.targetX === 2
      && item.action.targetY === 1
    ))
    expect(candidate).toBeDefined()
    if (!candidate) return
    const definition = fixture.state.skillsById['naruto-shadow-clone'] as any
    definition.code = "function executeSkill(context) { var caster = context.piece; "
      + mutateCode
      + " context.summonQueue.push({ summons: [{ x: 2, y: 1, variant: 'summon' }], sourceId: caster.instanceId });"
      + " return { success: true, message: 'corrupt source probe' }; }"
    const beforeHash = hashBattleState(fixture.state)
    const beforeJson = JSON.stringify(fixture.state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()
    const actionId = 'red139-source-mirror-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    let caught: unknown

    try {
      runBattleAction(
        fixture.state,
        { ...candidate.action, clientActionId: actionId } as any,
        { rootSeed: ROOT_SEED },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: expect.objectContaining({
        actionId,
        kind: 'summon',
        sourceId: 'naruto',
        skillId: 'naruto-shadow-clone',
        detached: false,
      }),
    })
    expect((caught as Error).message).toContain(message)
    expect(hashBattleState(fixture.state)).toBe(beforeHash)
    expect(JSON.stringify(fixture.state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(fixture.naruto).toMatchObject({ currentHp: 67, faction: 'red', x: 1, y: 1 })
    expect(fixture.state.pieces.some((piece: any) => piece.instanceId.startsWith('naruto-clone-'))).toBe(false)
    expect(fixture.state.players[0].actionPoints).toBe(10)
  })

  it.each([
    {
      name: 'NaN HP',
      message: 'neither active living nor finalized in graveyard',
      mutate: (battle: any, anchor: any) => { anchor.currentHp = Number.NaN },
    },
    {
      name: 'infinite HP',
      message: 'neither active living nor finalized in graveyard',
      mutate: (battle: any, anchor: any) => { anchor.currentHp = Number.POSITIVE_INFINITY },
    },
    {
      name: 'invalid faction',
      message: 'source faction must be red or blue',
      mutate: (battle: any, anchor: any) => { anchor.faction = 'green' },
    },
    {
      name: 'fallback faction mismatch',
      message: 'fallback faction does not match its source',
      mutate: (battle: any, anchor: any) => {
        anchor.faction = 'blue'
        battle.players.find((player: any) => player.playerId === 'player-red').faction = 'blue'
      },
    },
  ])('rejects stored-recipe board source $name and restores damage, resources, and rule limits', ({
    name,
    message,
    mutate,
  }) => {
    const fixture = makeDemonState(true)
    const mutationRule = eventRule(
      'red139-stored-source-' + name,
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'demon-summon-5') return
        const anchor = battle.pieces.find((piece: any) => piece.instanceId === 'demon-anchor')
        mutate(battle, anchor)
      },
    ) as any
    mutationRule.limits = { maxUses: 3, uses: 0, cooldownTurns: 2, currentCooldown: 0 }
    globalTriggerSystem.addRule(mutationRule)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()
    const beforeHash = hashBattleState(fixture.state)
    const beforeJson = JSON.stringify(fixture.state)
    let caught: unknown

    try {
      runBattleAction(fixture.state, fixture.action as any, { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: expect.objectContaining({
        kind: 'summon',
        sourceId: 'demon-anchor',
        skillId: 'demon-summon-5',
        detached: false,
      }),
    })
    expect((caught as Error).message).toContain(message)
    expect(hashBattleState(fixture.state)).toBe(beforeHash)
    expect(JSON.stringify(fixture.state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(mutationRule.limits).toEqual({
      maxUses: 3,
      uses: 0,
      cooldownTurns: 2,
      currentCooldown: 0,
    })
    expect(fixture.anchor).toMatchObject({ currentHp: 20, attack: 3, faction: 'red' })
    expect(fixture.state.players[0]).toMatchObject({
      faction: 'red',
      actionPoints: 3,
      hand: [{ cardId: 'demon-summon-5' }],
      discardPile: [],
    })
  })

  it.each([
    { name: 'invalid', faction: 'green' },
    { name: 'source-mismatched', faction: 'blue' },
  ])('rejects $name stored-piece faction before Summon commit and rolls back the root action', ({
    faction,
  }) => {
    const fixture = makeDemonState(true)
    ;(fixture.state.extensions.kiljaedanPiece as any).faction = faction
    const beforeHash = hashBattleState(fixture.state)
    const beforeJson = JSON.stringify(fixture.state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()
    let caught: unknown

    try {
      runBattleAction(fixture.state, fixture.action as any, { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: expect.objectContaining({
        kind: 'summon',
        sourceId: 'demon-anchor',
        skillId: 'demon-summon-5',
        detached: false,
      }),
    })
    expect((caught as Error).message).toContain('stable Piece schema')
    expect(hashBattleState(fixture.state)).toBe(beforeHash)
    expect(JSON.stringify(fixture.state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(fixture.anchor).toMatchObject({ currentHp: 20, attack: 3, faction: 'red' })
    expect(fixture.state.players[0]).toMatchObject({
      actionPoints: 3,
      hand: [{ cardId: 'demon-summon-5' }],
      discardPile: [],
    })
  })

  it('fails a malformed stored-piece capability value closed before commit', () => {
    const { action, anchor, state } = makeDemonState(true)
    const stored = state.extensions.kiljaedanPiece as Record<string, unknown>
    stored.maxHp = Number.NaN
    let thrown: any

    try {
      runBattleAction(state, action as any, { rootSeed: ROOT_SEED })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: expect.objectContaining({
        kind: 'summon',
        skillId: 'demon-summon-5',
      }),
    })
    expect(Number.isNaN((state.extensions.kiljaedanPiece as any).maxHp)).toBe(true)
    expect(anchor).toMatchObject({ currentHp: 20, attack: 3 })
    const red = state.players.find((player: any) => player.playerId === 'player-red')
    expect(red).toMatchObject({ actionPoints: 3, discardPile: [] })
    expect(red.hand.map((card: any) => card.cardId)).toEqual(['demon-summon-5'])
    expect(state.pieces.map((piece: any) => piece.instanceId)).toEqual(['demon-anchor'])
  })

  it('creates the real demon-summon-5 Kiljaedan recipe deterministically from the same seed', () => {
    const firstFixture = makeDemonState(false)
    const peerState = structuredClone(firstFixture.state)

    const authority = runBattleAction(firstFixture.state, firstFixture.action as any, { rootSeed: ROOT_SEED })
    const peer = runBattleAction(peerState, firstFixture.action as any, { rootSeed: ROOT_SEED })
    const authorityKiljaedan = authority.state.pieces.find(piece => piece.templateId === 'kiljaedan') as any
    const peerKiljaedan = peer.state.pieces.find(piece => piece.templateId === 'kiljaedan') as any

    expect(authority.stateHash).toBe(peer.stateHash)
    expect(authorityKiljaedan?.instanceId).toBe(peerKiljaedan?.instanceId)
    expect(authorityKiljaedan).toMatchObject({
      name: '基尔加丹',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 2,
      y: 2,
      currentHp: 17,
      maxHp: 17,
      attack: 4,
      defense: 3,
      moveRange: 4,
    })
    expect(authorityKiljaedan.skills.map((skill: any) => skill.skillId)).toEqual([
      'kiljaedan-demonic-pact',
      'kiljaedan-fel-fire',
      'kiljaedan-soul-drain',
    ])
  })
})
