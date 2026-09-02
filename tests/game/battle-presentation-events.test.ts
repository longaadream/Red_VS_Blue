import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  getProjectilePresentationTravel,
  projectBattlePresentationEvents,
  type BattlePresentationEvent,
} from '@/lib/game/battle-presentation-events'
import { hashBattleState } from '@/lib/game/battle-runner'
import {
  createPublicBattleTransitionUpdate,
  type DispatchRoomBattleActionResult,
} from '@/lib/game/room-battle-actions'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makeState } from '../helpers/minimal-state'

function piece(id: string, ownerPlayerId: string, hp: number, statuses: unknown[] = []) {
  const faction: 'red' | 'blue' = ownerPlayerId === 'player-red' ? 'red' : 'blue'
  return {
    instanceId: id,
    templateId: id,
    name: id,
    ownerPlayerId,
    faction,
    currentHp: hp,
    maxHp: 10,
    attack: 1,
    defense: 0,
    moveRange: 3,
    actionPoints: 2,
    maxActionPoints: 2,
    chargePoints: 0,
    maxChargePoints: 0,
    usedSkills: [],
    hasMoved: false,
    x: id === 'source' ? 0 : 1,
    y: 0,
    skills: [],
    buffs: [],
    debuffs: [],
    statusTags: statuses,
    ruleTags: [],
    rules: [],
  }
}

function stateWithPieces(pieces: ReturnType<typeof piece>[]): BattleState {
  const state = makeState()
  state.pieces = pieces as BattleState['pieces']
  state.actions = []
  return state
}

function project(
  command: BattleAction,
  beforeState: BattleState,
  afterState: BattleState,
  actionId = 'authority-action-7',
): BattlePresentationEvent[] {
  return projectBattlePresentationEvents({ actionId, command, beforeState, afterState })
}

describe('RED-165 authoritative battle presentation events', () => {
  it('declares presentation travel for every projectile skill', () => {
    const skillDirectory = resolve(process.cwd(), 'data/skills')
    const projectileSkills = readdirSync(skillDirectory)
      .filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync(resolve(skillDirectory, file), 'utf8')) as { id: string; form?: string })
      .filter(skill => skill.form === 'projectile')

    const actual = Object.fromEntries(projectileSkills.map(skill => [
      skill.id,
      getProjectilePresentationTravel(skill.id),
    ]))
    expect(actual).toEqual({
      'blackwidow-lethal-strike': 'first-collision',
      'hellfire-shotgun': 'first-collision',
      'ichigo-black-getsuga-tensho': 'through-pieces',
      'ichigo-getsuga-tensho': 'first-collision',
      'nano-boost': 'selected-target',
      'sleep-dart': 'first-collision',
      'venom-symbiote-drag': 'first-collision',
    })
  })

  it.each([
    [{ type: 'move', playerId: 'player-red', pieceId: 'source', toX: 2, toY: 3 }, 'move', 'action-move'],
    [{ type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-basic' }, 'skill', 'action-skill'],
    [{ type: 'useChargeSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-charge' }, 'chargeSkill', 'action-charge-skill'],
    [{ type: 'playCard', playerId: 'player-red', cardInstanceId: 'ci-1' }, 'card', 'action-card'],
  ] as const)('projects %s as one stable root', (command, kind, iconId) => {
    const before = stateWithPieces([piece('source', 'player-red', 10)])
    if (kind === 'card') before.players[0].hand = [{ cardId: 'card-fire', instanceId: 'ci-1', ownerPlayerId: 'player-red', actionPointCost: 1 }]
    const after = structuredClone(before)
    const events = project(command as BattleAction, before, after)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      eventId: 'authority-action-7:0',
      rootEventId: 'authority-action-7:0',
      sequence: 0,
      kind,
      iconId,
      actorPlayerId: 'player-red',
      skippable: true,
    })
    if (kind === 'card') expect(events[0]).not.toHaveProperty('sourcePieceId')
    else expect(events[0].sourcePieceId).toBe('source')
    if (kind === 'card') expect(events[0].cardId).toBe('card-fire')
    if (kind === 'move') expect(events[0].result).toEqual({ fromX: 0, fromY: 0, toX: 2, toY: 3 })
  })

  it('groups settled results under the root in stable authority order without reading localized messages', () => {
    const before = stateWithPieces([
      piece('source', 'player-red', 10),
      piece('target', 'player-blue', 10, [
        { id: 'old', type: 'anti-heal', name: '禁疗', visible: true, currentDuration: 1 },
        { id: 'internal', type: 'shishio-dmg-counter', visible: false, stacks: 9 },
      ]),
      piece('ally', 'player-red', 4),
    ])
    const after = structuredClone(before)
    after.pieces.find(entry => entry.instanceId === 'target')!.currentHp = 0
    after.pieces.find(entry => entry.instanceId === 'target')!.statusTags = [
      { id: 'burn', type: 'amaterasu-burn', name: '天照', visible: true, currentDuration: 2, stacks: 1 },
      { id: 'counter', type: 'shishio-dmg-counter', visible: true, stacks: 99 },
    ]
    after.pieces.find(entry => entry.instanceId === 'ally')!.currentHp = 7
    after.actions = [
      {
        type: 'triggerEffect',
        playerId: 'player-blue',
        turn: 1,
        payload: { message: '这段中文不能成为表现事件', ruleId: 'rule-divine-shield', sourceId: 'target', targetId: 'target' },
      },
      {
        type: 'damage',
        playerId: 'player-red',
        turn: 1,
        payload: {
          batchId: 'damage-1', chainId: 'chain-1', sourceId: 'source', skillId: 'skill-basic',
          targetId: 'target', finalDamage: 10, shieldAbsorbed: 2, blocked: false, killed: true,
        },
      },
      {
        type: 'triggerEffect',
        playerId: 'player-red',
        turn: 1,
        payload: { message: '只有文字，没有 ruleId，不得投影' },
      },
    ]

    const events = project({
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-basic', targetPieceId: 'target',
    }, before, after)

    expect(events.map(event => event.kind)).toEqual([
      'skill', 'passive', 'shield', 'damage', 'death', 'heal', 'statusRemoved', 'statusAdded',
    ])
    expect(events.map(event => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(new Set(events.map(event => event.rootEventId))).toEqual(new Set(['authority-action-7:0']))
    expect(events.slice(1).every(event => event.parentEventId === 'authority-action-7:0')).toBe(true)
    expect(events.find(event => event.kind === 'passive')).toMatchObject({
      sourcePieceId: 'target', targetPieceIds: ['target'], ruleId: 'rule-divine-shield', iconId: 'action-passive',
    })
    expect(events.find(event => event.kind === 'shield')).toMatchObject({
      targetPieceIds: ['target'], result: { absorbed: 2, blocked: false }, iconId: 'shield',
    })
    expect(events.find(event => event.kind === 'damage')).toMatchObject({
      sourcePieceId: 'source', targetPieceIds: ['target'], skillId: 'skill-basic', result: { amount: 10 },
    })
    expect(events.find(event => event.kind === 'heal')).toMatchObject({
      sourcePieceId: 'source', targetPieceIds: ['ally'], result: { amount: 3 }, iconId: 'action-heal',
    })
    expect(events.find(event => event.kind === 'statusRemoved')).toMatchObject({
      targetPieceIds: ['target'], statusType: 'anti-heal', statusId: 'old',
    })
    expect(events.find(event => event.kind === 'statusAdded')).toMatchObject({
      targetPieceIds: ['target'], statusType: 'amaterasu-burn', statusId: 'burn',
    })
    expect(JSON.stringify(events)).not.toContain('这段中文')
    expect(JSON.stringify(events)).not.toContain('只有文字')
    expect(JSON.stringify(events)).not.toContain('shishio-dmg-counter')
  })

  it('is deterministic, JSON-safe, non-mutating, and hash-neutral', () => {
    const before = stateWithPieces([piece('source', 'player-red', 10), piece('target', 'player-blue', 10)])
    const after = structuredClone(before)
    after.pieces[1].currentHp = 8
    after.actions = [{
      type: 'damage', playerId: 'player-red', turn: 1,
      payload: { sourceId: 'source', targetId: 'target', finalDamage: 2, blocked: false, killed: false },
    }]
    const command = {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-basic', targetPieceId: 'target',
    } as BattleAction
    const beforeCopy = structuredClone(before)
    const afterCopy = structuredClone(after)
    const preHash = hashBattleState(before)
    const postHash = hashBattleState(after)

    const first = project(command, before, after)
    const second = project(command, before, after)

    expect(first).toEqual(second)
    expect(JSON.parse(JSON.stringify(first))).toEqual(first)
    expect(before).toEqual(beforeCopy)
    expect(after).toEqual(afterCopy)
    expect(hashBattleState(before)).toBe(preHash)
    expect(hashBattleState(after)).toBe(postHash)
    expect(first.map(event => event.eventId)).toEqual(['authority-action-7:0', 'authority-action-7:1'])
  })

  it('transports events outside the public state patch and hashes', () => {
    const before = stateWithPieces([piece('source', 'player-red', 10)])
    const after = structuredClone(before)
    after.pieces[0].x = 2
    after.pieces[0].y = 3
    const command = { type: 'move', playerId: 'player-red', pieceId: 'source', toX: 2, toY: 3 } as BattleAction
    const events = project(command, before, after)
    const result = {
      transition: { fromVersion: 0, toVersion: 1, playerId: 'player-red' },
      previousAuthorityState: before,
      nextAuthorityState: after,
      receipt: {
        roomId: 'red165-presentation-room', clientActionId: 'client-action-1',
        status: 'applied', authorityVersion: 1,
      },
      snapshot: { seed: 7 },
      presentationEvents: events,
    } as unknown as DispatchRoomBattleActionResult

    const update = createPublicBattleTransitionUpdate(
      result,
      'red165-presentation-room',
      'player-red',
      { now: () => 1000 },
    )

    expect(update?.presentationEvents).toEqual(events)
    expect(JSON.stringify(update?.patch)).not.toContain('presentationEvents')
    expect(update?.stateHash).toBe(update?.postPublicHash)
  })

  it('projects a first-collision projectile past the selected direction cell to its authoritative blocker', () => {
    const before = makeState({
      width: 6,
      height: 1,
      pieces: [
        piece('source', 'player-red', 10),
        { ...piece('ally-blocker', 'player-red', 10), x: 2, y: 0 },
      ],
    })
    before.skillsById['blackwidow-lethal-strike'] = {
      id: 'blackwidow-lethal-strike',
      name: 'First collision',
      description: '',
      kind: 'active',
      type: 'normal',
      form: 'projectile',
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      code: '',
      range: 'single',
      requiresTarget: true,
      actionPointCost: 1,
      targeting: { steps: [{ kind: 'target', type: 'grid', filter: 'all', range: 5 }] },
    }
    const after = structuredClone(before)

    const events = project({
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'source',
      skillId: 'blackwidow-lethal-strike',
      targetX: 1,
      targetY: 0,
    }, before, after)

    expect(events[0].presentation).toEqual({
      cue: 'projectile',
      selectedCell: { x: 1, y: 0 },
      pathCells: [{ x: 1, y: 0 }, { x: 2, y: 0 }],
      endPoint: { x: 2, y: 0 },
      endReason: 'blocked',
      collisions: [{ kind: 'piece', x: 2, y: 0, pieceId: 'ally-blocker', blocking: true }],
    })
  })

  it('keeps a through-pieces projectile travelling beyond the selected cell and all hit pieces', () => {
    const before = makeState({
      width: 6,
      height: 1,
      pieces: [
        piece('source', 'player-red', 10),
        { ...piece('near-target', 'player-blue', 10), x: 2, y: 0 },
        { ...piece('far-target', 'player-blue', 10), x: 4, y: 0 },
      ],
    })
    before.skillsById['ichigo-black-getsuga-tensho'] = {
      id: 'ichigo-black-getsuga-tensho',
      name: 'Through pieces',
      description: '',
      kind: 'active',
      type: 'normal',
      form: 'projectile',
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      code: '',
      range: 'single',
      requiresTarget: true,
      actionPointCost: 1,
      targeting: { steps: [{ kind: 'target', type: 'grid', filter: 'all', range: 99 }] },
    }
    const after = structuredClone(before)
    after.pieces.find(entry => entry.instanceId === 'near-target')!.currentHp = 8
    after.pieces.find(entry => entry.instanceId === 'far-target')!.currentHp = 8
    after.actions = [
      {
        type: 'damage', playerId: 'player-red', turn: 1,
        payload: { sourceId: 'source', targetId: 'near-target', finalDamage: 2, blocked: false, killed: false },
      },
      {
        type: 'damage', playerId: 'player-red', turn: 1,
        payload: { sourceId: 'source', targetId: 'far-target', finalDamage: 2, blocked: false, killed: false },
      },
    ]

    const events = project({
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'source',
      skillId: 'ichigo-black-getsuga-tensho',
      targetX: 1,
      targetY: 0,
    }, before, after)

    expect(events[0].presentation).toMatchObject({
      cue: 'projectile',
      selectedCell: { x: 1, y: 0 },
      endPoint: { x: 5, y: 0 },
      endReason: 'boundary',
    })
    expect(events[0].presentation?.pathCells).toEqual([
      { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 0 },
    ])
    expect(events[0].presentation?.collisions).toEqual([
      { kind: 'piece', x: 2, y: 0, pieceId: 'near-target', blocking: false },
      { kind: 'piece', x: 4, y: 0, pieceId: 'far-target', blocking: false },
      { kind: 'boundary', x: 6, y: 0, blocking: true },
    ])
  })
})
