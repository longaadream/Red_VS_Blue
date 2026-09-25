/* eslint-disable @typescript-eslint/no-explicit-any -- JSON content is exercised through the real action runner. */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { applyBattleAction, type BattleAction, type BattleState } from '@/lib/game/turn'
import { loadAllSkillsById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { prepareAction, targetRefKey } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 216216

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function makeParasitismState(options: {
  attackerOwner?: 'player-blue' | 'player-red'
  attackerId?: string
  attackerX?: number
  attackerY?: number
  hostX?: number
  hostY?: number
  muzanX?: number
  muzanY?: number
  muzanHp?: number
  hostHp?: number
  chargePoints?: number
  hostSkillId?: string
} = {}): { state: BattleState; muzan: any; host: any; attacker: any } {
  const attackerOwner = options.attackerOwner ?? 'player-blue'
  const attackerFaction = attackerOwner === 'player-blue' ? 'blue' : 'red'
  const muzan = makePiece({
    instanceId: 'muzan',
    templateId: 'dark-muzan',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: options.muzanX ?? 2,
    y: options.muzanY ?? 1,
    currentHp: options.muzanHp ?? 1,
    maxHp: 15,
    attack: 4,
    skills: [{ skillId: 'muzan-parasitism', currentCooldown: 0 }],
  }) as any
  muzan.isCore = true
  const host = makePiece({
    instanceId: 'host',
    templateId: 'host-piece',
    ownerPlayerId: attackerOwner,
    faction: attackerFaction,
    x: options.hostX ?? 3,
    y: options.hostY ?? 1,
    currentHp: options.hostHp ?? 8,
    maxHp: 10,
    attack: 10,
    skills: options.hostSkillId ? [{ skillId: options.hostSkillId, currentCooldown: 0 }] : [],
  }) as any
  const attacker = makePiece({
    instanceId: options.attackerId ?? 'attacker',
    templateId: 'arthas',
    ownerPlayerId: attackerOwner,
    faction: attackerFaction,
    x: options.attackerX ?? 1,
    y: options.attackerY ?? 1,
    currentHp: 10,
    maxHp: 10,
    attack: 10,
    skills: [{ skillId: options.hostSkillId ?? 'arthas-frostmourne', currentCooldown: 0 }],
  }) as any
  const state = makeState({
    pieces: [muzan, host, attacker],
    width: 8,
    height: 6,
    currentPlayerId: attackerOwner,
  }) as any
  state.skillsById = loadAllSkillsById()
  state.players.find((player: any) => player.playerId === 'player-red').chargePoints = options.chargePoints ?? 2
  state.players.find((player: any) => player.playerId === attackerOwner).actionPoints = 2
  return { state, muzan, host, attacker }
}

function attackMuzanAction(state: BattleState, attacker: any, skillId = 'arthas-frostmourne'): BattleAction {
  const base = {
    type: 'useBasicSkill' as const,
    playerId: attacker.ownerPlayerId,
    pieceId: attacker.instanceId,
    skillId,
  }
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, got ${prepared.kind}`)
  expect(prepared.candidates.map(targetRefKey)).toContain('piece:muzan')
  return {
    ...base,
    targetPieceId: 'muzan',
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

function rangedAttackMuzanAction(state: BattleState, attacker: any): BattleAction {
  const base = {
    type: 'useBasicSkill' as const,
    playerId: attacker.ownerPlayerId,
    pieceId: attacker.instanceId,
    skillId: 'alfonso-kick',
  }
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected grid target selection, got ${prepared.kind}`)
  expect(prepared.candidates.map(targetRefKey)).toContain('cell:3,0')
  return {
    ...base,
    targetX: 3,
    targetY: 0,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

function chooseHost(state: BattleState, pieceId: string): BattleState {
  const pending = state.pendingTargetSelection!
  return runBattleAction(state, {
    type: 'pendingTargetSelect',
    playerId: pending.playerId,
    targetPieceId: pieceId,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  }).state
}

function chooseCell(state: BattleState, x: number, y: number): BattleState {
  const pending = state.pendingTargetSelection!
  return runBattleAction(state, {
    type: 'pendingTargetSelect',
    playerId: pending.playerId,
    targetX: x,
    targetY: y,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  }).state
}

beforeEach(() => globalTriggerSystem.clearRules())

describe('RED-216 Muzan parasitism', () => {
  it('loads the closed declaration and uses the confirmed Chinese description', () => {
    const skill = readJson('data/skills/muzan-parasitism.json')
    expect(skill).toMatchObject({
      id: 'muzan-parasitism',
      kind: 'passive',
      chargeCost: 2,
      deathParasitism: {
        version: 1,
        squareRadius: 2,
        chargeCost: 2,
        grantSkillId: 'muzan-flesh-regeneration',
      },
    })
    expect(skill.description).toBe('即将死亡时，若自身为中心5×5范围内有其他棋子，可花费2点充能点，选择其中一个棋子并传送至其相邻地格，将血液注入：该棋子成为己方棋子并获得被动「血肉再生」，随后无惨死亡。')
  })

  it('suspends for the Mu side, then transfers the selected host and finishes normal death', () => {
    const { state, muzan, host, attacker } = makeParasitismState()
    const attack = attackMuzanAction(state, attacker)
    const first = runBattleAction(state, attack, { rootSeed: ROOT_SEED }).state

    expect(first.pendingTargetSelection).toMatchObject({ playerId: 'player-red', targetType: 'piece' })
    expect(first.players.find((player: any) => player.playerId === 'player-red')?.chargePoints).toBe(2)
    expect(first.players.find((player: any) => player.playerId === 'player-blue')?.actionPoints).toBe(2)
    expect(first.pieces.find((piece: any) => piece.instanceId === muzan.instanceId)?.currentHp).toBe(1)

    const second = chooseHost(first, host.instanceId)
    expect(second.pendingTargetSelection).toMatchObject({ playerId: 'player-red', targetType: 'cell' })
    expect(second.pendingTargetSelection?.candidates).toContainEqual({ type: 'cell', x: 4, y: 1 })

    const completed = chooseCell(second, 4, 1)
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.players.find((player: any) => player.playerId === 'player-red')?.chargePoints).toBe(0)
    expect(completed.players.find((player: any) => player.playerId === 'player-blue')?.actionPoints).toBe(1)
    expect(completed.pieces.find((piece: any) => piece.instanceId === muzan.instanceId)).toBeUndefined()
    expect(completed.graveyard).toContainEqual(expect.objectContaining({ instanceId: muzan.instanceId, currentHp: 0, x: 4, y: 1 }))
    const completedHost = completed.pieces.find((piece: any) => piece.instanceId === host.instanceId)!
    expect(completedHost).toMatchObject({ ownerPlayerId: 'player-red', faction: 'red', currentHp: 8, maxHp: 10, attack: 10, x: 3, y: 1 })
    expect(completedHost.skills).toContainEqual(expect.objectContaining({ skillId: 'muzan-flesh-regeneration' }))
    expect(completedHost.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rule-muzan-regeneration-damage' }),
      expect.objectContaining({ id: 'rule-muzan-regeneration-end' }),
    ]))
    expect(completed.extensions?.flowState).toBeUndefined()
    expect(completed.graveyard.some((piece: any) => piece.instanceId === muzan.instanceId)).toBe(true)
    expect(completed.actions?.some((action: any) => action.type === 'chargeCrystalDropped' && action.payload.sourcePieceId === muzan.instanceId)).toBe(true)
    expect(completed.actions?.find((action: any) => action.type === 'deathParasitism')).toMatchObject({
      playerId: 'player-red',
      payload: {
        message: expect.stringContaining('寄生成功'),
        sourcePieceId: muzan.instanceId,
        hostId: host.instanceId,
        originalHostOwnerPlayerId: 'player-blue',
        newHostOwnerPlayerId: 'player-red',
        chargeCost: 2,
        skillId: 'muzan-parasitism',
        grantSkillId: 'muzan-flesh-regeneration',
      },
    })
  })

  it('cancels without charge and lets the original lethal attack complete', () => {
    const { state, muzan, host, attacker } = makeParasitismState()
    const first = runBattleAction(state, attackMuzanAction(state, attacker), { rootSeed: ROOT_SEED }).state
    const pending = first.pendingTargetSelection!
    const cancelled = runBattleAction(first, {
      type: 'cancelPendingSelection',
      playerId: pending.playerId,
      selectionId: pending.selectionId,
      stateRevision: pending.stateRevision,
    }).state

    expect(cancelled.pendingTargetSelection).toBeUndefined()
    expect(cancelled.players.find((player: any) => player.playerId === 'player-red')?.chargePoints).toBe(2)
    expect(cancelled.pieces.find((piece: any) => piece.instanceId === host.instanceId)?.ownerPlayerId).toBe('player-blue')
    expect(cancelled.graveyard).toContainEqual(expect.objectContaining({ instanceId: muzan.instanceId, currentHp: 0 }))
  })

  it('does not prompt when charge, host, or adjacent landing is unavailable', () => {
    const noCharge = makeParasitismState({ chargePoints: 1 })
    const noChargeResult = runBattleAction(noCharge.state, attackMuzanAction(noCharge.state, noCharge.attacker), { rootSeed: ROOT_SEED }).state
    expect(noChargeResult.pendingTargetSelection).toBeUndefined()
    expect(noChargeResult.graveyard).toContainEqual(expect.objectContaining({ instanceId: noCharge.muzan.instanceId }))
    expect(noChargeResult.players.find((player: any) => player.playerId === 'player-red')?.chargePoints).toBe(1)

    const noHost = makeParasitismState({ muzanX: 3, muzanY: 0, hostX: 5, hostY: 5, attackerX: 0, attackerY: 0, hostSkillId: 'alfonso-kick' })
    const noHostResult = runBattleAction(noHost.state, rangedAttackMuzanAction(noHost.state, noHost.attacker), { rootSeed: ROOT_SEED }).state
    expect(noHostResult.pendingTargetSelection).toBeUndefined()
    expect(noHostResult.players.find((player: any) => player.playerId === 'player-red')?.chargePoints).toBe(2)
    expect(noHostResult.graveyard).toContainEqual(expect.objectContaining({ instanceId: noHost.muzan.instanceId }))
  })

  it('preserves the original attacker attribution when the attacker is the selected host', () => {
    const { state, muzan, host: fixtureHost, attacker: host } = makeParasitismState({
      attackerId: 'host',
      attackerX: 3,
      attackerY: 1,
      hostSkillId: 'arthas-frostmourne',
    })
    // The fixture's ordinary host and attacker intentionally share the target
    // ID in this scenario. Keep only the attacker object as the canonical host
    // so DeathBatch sees one stable instance rather than two same-ID pieces.
    state.pieces = state.pieces.filter((piece: any) => piece !== fixtureHost)
    const first = runBattleAction(state, attackMuzanAction(state, host), { rootSeed: ROOT_SEED }).state
    expect(first.pendingTargetSelection?.playerId).toBe('player-red')
    const second = chooseHost(first, host.instanceId)
    const completed = chooseCell(second, 4, 1)
    const damageLog = completed.actions?.find((action: any) => action.type === 'damage' && action.payload.targetId === muzan.instanceId)

    expect(completed.pieces.find((piece: any) => piece.instanceId === host.instanceId)?.ownerPlayerId).toBe('player-red')
    expect(damageLog).toMatchObject({ playerId: 'player-blue', payload: { damageSource: { playerId: 'player-blue' } } })
    expect(completed.players.find((player: any) => player.playerId === 'player-red')?.chargePoints).toBe(0)
    expect(completed.players.find((player: any) => player.playerId === 'player-blue')?.actionPoints).toBe(1)
  })

  it('works through applyBattleAction after the same two-step pending protocol', () => {
    const { state, muzan, host, attacker } = makeParasitismState()
    const first = applyBattleAction(state, attackMuzanAction(state, attacker))
    expect(first.pendingTargetSelection?.playerId).toBe('player-red')
    const secondPending = first.pendingTargetSelection!
    const second = applyBattleAction(first, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: host.instanceId,
      selectionId: secondPending.selectionId, stateRevision: secondPending.stateRevision,
    })
    const thirdPending = second.pendingTargetSelection!
    const completed = applyBattleAction(second, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 4, targetY: 1,
      selectionId: thirdPending.selectionId, stateRevision: thirdPending.stateRevision,
    })
    expect(completed.pieces.find((piece: any) => piece.instanceId === host.instanceId)?.ownerPlayerId).toBe('player-red')
    expect(completed.graveyard).toContainEqual(expect.objectContaining({ instanceId: muzan.instanceId }))
  })

  it('allows two same-batch Muzans to inject the same living host independently', () => {
    const firstMuzan = makePiece({
      instanceId: 'mu-a', templateId: 'dark-muzan', ownerPlayerId: 'player-red', faction: 'red',
      x: 2, y: 1, currentHp: 1, maxHp: 15, attack: 4,
      skills: [{ skillId: 'muzan-parasitism', currentCooldown: 0 }],
    }) as any
    const secondMuzan = makePiece({
      instanceId: 'mu-b', templateId: 'dark-muzan', ownerPlayerId: 'player-red', faction: 'red',
      x: 2, y: 3, currentHp: 1, maxHp: 15, attack: 4,
      skills: [{ skillId: 'muzan-parasitism', currentCooldown: 0 }],
    }) as any
    const host = makePiece({
      instanceId: 'shared-host', templateId: 'host-piece', ownerPlayerId: 'player-red', faction: 'red',
      x: 3, y: 2, currentHp: 8, maxHp: 10, attack: 10,
    }) as any
    // Persisted clients may carry the compact string form in displaySkills.
    host.displaySkills = ['muzan-flesh-regeneration']
    const attacker = makePiece({
      instanceId: 'multi-attacker', templateId: 'blue-attacker', ownerPlayerId: 'player-blue', faction: 'blue',
      x: 2, y: 2, currentHp: 10, maxHp: 10, attack: 4,
      skills: [{ skillId: 'arthas-frostmourne', currentCooldown: 0 }],
    }) as any
    const state = makeState({
      pieces: [firstMuzan, secondMuzan, host, attacker],
      width: 7,
      height: 5,
      currentPlayerId: 'player-blue',
    }) as any
    state.skillsById = loadAllSkillsById()
    state.players.find((player: any) => player.playerId === 'player-red').chargePoints = 4
    state.players.find((player: any) => player.playerId === 'player-blue').actionPoints = 2
    globalTriggerSystem.addRule({
      id: 'red216-same-batch-deaths',
      name: 'red216-same-batch-deaths',
      description: '',
      trigger: { type: 'beforeDamageDealt' },
      effect: (_battle: any, context: any) => {
        if (context.skillId !== 'arthas-frostmourne') return { success: true }
        if (!context.damageQueue || !context.sourcePiece) throw new Error('same-batch fixture did not receive a damage queue')
        context.damageQueue.push({
          attacker: context.sourcePiece,
          target: [firstMuzan, secondMuzan],
          damage: 4,
          damageType: 'physical',
          skillId: 'red216-same-batch-deaths',
        })
        return { success: true, blocked: true }
      },
    } as any)

    const attack: BattleAction = {
      type: 'useBasicSkill',
      playerId: 'player-blue',
      pieceId: attacker.instanceId,
      skillId: 'arthas-frostmourne',
    }
    const prepared = prepareAction(state, attack)
    if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, got ${prepared.kind}`)
    expect(prepared.candidates.map(targetRefKey)).toContain(`piece:${host.instanceId}`)
    attack.targetPieceId = host.instanceId
    attack.selectionId = prepared.selectionId
    attack.stateRevision = prepared.stateRevision
    const firstPending = runBattleAction(state, attack, { rootSeed: ROOT_SEED }).state
    expect(firstPending.pendingTargetSelection).toMatchObject({ playerId: 'player-red', targetType: 'piece' })

    const firstHostPending = chooseHost(firstPending, host.instanceId)
    const secondPending = chooseCell(firstHostPending, 3, 1)
    expect(secondPending.pendingTargetSelection).toMatchObject({ playerId: 'player-red', targetType: 'piece' })

    const secondHostPending = chooseHost(secondPending, host.instanceId)
    const completed = chooseCell(secondHostPending, 3, 3)

    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.players.find((player: any) => player.playerId === 'player-red')?.chargePoints).toBe(0)
    expect(completed.players.find((player: any) => player.playerId === 'player-blue')?.actionPoints).toBe(1)
    const deadMuzans = completed.graveyard.filter((piece: any) => [firstMuzan.instanceId, secondMuzan.instanceId].includes(piece.instanceId))
    expect(deadMuzans).toHaveLength(2)
    expect(deadMuzans.every((piece: any) => piece.currentHp === 0)).toBe(true)
    expect(deadMuzans.map((piece: any) => `${piece.x},${piece.y}`).sort()).toEqual(['3,1', '3,3'])
    const completedHost = completed.pieces.find((piece: any) => piece.instanceId === host.instanceId)!
    expect(completedHost.ownerPlayerId).toBe('player-red')
    expect(completedHost.currentHp).toBe(8)
    expect(completedHost.skills.filter((skill: any) => skill.skillId === 'muzan-flesh-regeneration')).toHaveLength(1)
    expect(completedHost.displaySkills?.filter((skill: any) => skill === 'muzan-flesh-regeneration' || skill.skillId === 'muzan-flesh-regeneration')).toHaveLength(1)
    expect(completedHost.rules.filter((rule: any) => rule.id === 'rule-muzan-regeneration-damage')).toHaveLength(1)
    expect(completedHost.rules.filter((rule: any) => rule.id === 'rule-muzan-regeneration-end')).toHaveLength(1)
    expect(completed.actions?.filter((action: any) => action.type === 'deathParasitism').map((action: any) => action.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePieceId: firstMuzan.instanceId, hostId: host.instanceId, chargeCost: 2 }),
      expect.objectContaining({ sourcePieceId: secondMuzan.instanceId, hostId: host.instanceId, chargeCost: 2 }),
    ]))
    const sameBatchDamageIds = completed.actions
      ?.filter((action: any) => action.type === 'damage' && [firstMuzan.instanceId, secondMuzan.instanceId].includes(action.payload.targetId))
      .map((action: any) => action.payload.batchId)
    expect(new Set(sameBatchDamageIds)).toHaveLength(1)
  })
})
