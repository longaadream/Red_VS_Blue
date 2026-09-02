import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  getProjectilePresentationTravel,
  projectBattlePresentationEvents,
  projectBattlePresentationEventsForViewer,
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

  it('authors only the current hidden-result skills through the shared visibility metadata', () => {
    for (const skillId of ['naruto-shadow-clone', 'recall', 'aizen-kyoka-suiguetsu']) {
      const skill = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills', `${skillId}.json`), 'utf8'))
      expect(skill.concealTargetInBattleLog).toBe(true)
    }
  })

  it.each([
    [{ type: 'move', playerId: 'player-red', pieceId: 'source', toX: 2, toY: 3 }, 'move', 'action-move'],
    [{ type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-basic' }, 'skill', 'action-skill'],
    [{ type: 'useChargeSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-charge' }, 'chargeSkill', 'action-charge-skill'],
    [{ type: 'playCard', playerId: 'player-red', cardInstanceId: 'ci-1' }, 'card', 'action-card'],
  ] as const)('projects %s as one stable root', (command, kind, iconId) => {
    const before = stateWithPieces([piece('source', 'player-red', 10)])
    if (kind === 'card') before.players[0].hand = [{ cardId: 'card-fire', instanceId: 'ci-1', ownerPlayerId: 'player-red', actionPointCost: 1 }]
    if (kind === 'skill' || kind === 'chargeSkill') {
      const skillId = (command as { skillId: string }).skillId
      before.skillsById[skillId] = {
        id: skillId, name: kind === 'skill' ? '烈焰斩' : '终极烈焰斩', kind: 'active', cooldown: 0,
        powerMultiplier: 1, range: 'single', actionPointCost: 1, code: '',
      } as never
    }
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
    if (kind === 'skill') expect(events[0].label).toBe('烈焰斩')
    if (kind === 'chargeSkill') expect(events[0].label).toBe('终极烈焰斩')
  })

  it('keeps non-skill authority actions projectable when a partial runtime state omits the skill registry', () => {
    const before = stateWithPieces([piece('source', 'player-red', 10)])
    const after = structuredClone(before)
    delete (before as Partial<BattleState>).skillsById
    delete (after as Partial<BattleState>).skillsById

    expect(() => project(
      { type: 'turnTimeout', now: 100 },
      before,
      after,
    )).not.toThrow()
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
      'skill', 'passive', 'block', 'damage', 'death', 'heal', 'statusRemoved', 'statusAdded',
    ])
    expect(events.map(event => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(new Set(events.map(event => event.rootEventId))).toEqual(new Set(['authority-action-7:0']))
    expect(events.slice(1).every(event => event.parentEventId === 'authority-action-7:0')).toBe(true)
    expect(events.find(event => event.kind === 'passive')).toMatchObject({
      sourcePieceId: 'target', targetPieceIds: ['target'], ruleId: 'rule-divine-shield', iconId: 'action-passive',
    })
    expect(events.find(event => event.kind === 'block')).toMatchObject({
      targetPieceIds: ['target'], result: { absorbed: 2, blocked: false }, iconId: 'action-block',
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
    after.players[0].hand = [{
      cardId: 'secret-drawn-card', instanceId: 'secret-card-instance', ownerPlayerId: 'player-red',
    }]
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

    const opponentUpdate = createPublicBattleTransitionUpdate(
      result,
      'red165-presentation-room',
      'player-blue',
      { now: () => 1000 },
    )
    const opponentPatch = JSON.stringify(opponentUpdate?.patch)
    expect(opponentPatch).toContain('hidden-card-0')
    expect(opponentPatch).not.toContain('secret-drawn-card')
    expect(opponentPatch).not.toContain('secret-card-instance')
  })

  it('projects atomic board, resource, hand, tile and piece-stat changes under one root', () => {
    const before = stateWithPieces([
      piece('source', 'player-red', 10),
      piece('target', 'player-blue', 10),
    ])
    before.players[0].actionPoints = 5
    before.players[0].chargePoints = 1
    before.players[0].hand = [{ cardId: 'old-card', instanceId: 'old-1', ownerPlayerId: 'player-red' }]
    before.map.tiles[0].props.type = 'floor'
    before.extensions = { tileEffects: [] }
    const after = structuredClone(before)
    after.players[0].actionPoints = 3
    after.players[0].chargePoints = 2
    after.players[0].hand = [{ cardId: 'new-card', instanceId: 'new-1', ownerPlayerId: 'player-red' }]
    after.pieces[1].x = 3
    after.pieces[1].attack = 4
    after.map.tiles[0].props.type = 'wall'
    after.extensions = { tileEffects: [{ id: 'fire-1', tileType: 'amaterasu', x: 0, y: 0 }] }

    const events = project({
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-basic', targetPieceId: 'target',
    }, before, after)

    expect(events.map(event => event.kind)).toEqual(expect.arrayContaining([
      'forceMove', 'actionPoints', 'chargePoints', 'cardGained', 'cardDiscarded',
      'tileChanged', 'tileEffectAdded', 'statChanged',
    ]))
    expect(events.find(event => event.kind === 'actionPoints')?.result).toMatchObject({ amount: -2, value: 3 })
    expect(events.find(event => event.kind === 'chargePoints')?.result).toMatchObject({ amount: 1, value: 2 })
    expect(events.find(event => event.kind === 'forceMove')).toMatchObject({
      targetPieceIds: ['target'], targetCell: { x: 3, y: 0 },
    })
  })

  it('records only the final pending choice and projects option, piece and tile results', () => {
    const before = stateWithPieces([piece('source', 'player-red', 10), piece('target', 'player-blue', 10)])
    before.pendingOptionSelection = {
      playerId: 'player-red', title: '选择方式', options: [{ label: '传送', value: 'teleport' }],
      source: { type: 'skill', id: 'skill-choice', pieceId: 'source' },
    }
    const after = structuredClone(before)
    after.pendingOptionSelection = undefined
    const optionEvents = project({
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: 'teleport',
    }, before, after)
    expect(optionEvents).toHaveLength(1)
    expect(optionEvents[0]).toMatchObject({
      kind: 'choiceResolved', iconId: 'action-choice', complement: { kind: 'option', label: '传送' },
    })
    expect(optionEvents[0].visibility).toBeUndefined()

    const targetBefore = structuredClone(after)
    targetBefore.pendingTargetSelection = {
      playerId: 'player-red', targetType: 'cell', candidates: [{ type: 'cell', x: 2, y: 3 }],
      source: { type: 'skill', id: 'skill-choice', pieceId: 'source' },
    }
    const targetAfter = structuredClone(targetBefore)
    targetAfter.pendingTargetSelection = undefined
    const tileEvents = project({
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 2, targetY: 3,
    } as BattleAction, targetBefore, targetAfter)
    expect(tileEvents[0]).toMatchObject({ kind: 'choiceResolved', targetCell: { x: 2, y: 3 } })
  })

  it('keeps Naruto shadow-clone choices private to the acting player', () => {
    const before = stateWithPieces([piece('source', 'player-red', 10), piece('target', 'player-blue', 10)])
    before.skillsById['naruto-shadow-clone'] = {
      id: 'naruto-shadow-clone', name: '影分身之术', kind: 'normal', cooldown: 0,
      powerMultiplier: 0, range: 'single', actionPointCost: 1, code: '',
      concealTargetInBattleLog: true,
    } as never
    before.pendingOptionSelection = {
      playerId: 'player-red', title: '选择影分身方式',
      options: [{ label: '传送至目标格，原地留下分身', value: 'teleport' }],
      source: { type: 'skill', id: 'naruto-shadow-clone', pieceId: 'source' },
    }
    const after = structuredClone(before)
    after.pendingOptionSelection = undefined
    const authorityEvents = project({
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: 'teleport',
    }, before, after)

    expect(projectBattlePresentationEventsForViewer(authorityEvents, 'player-red')[0]).toMatchObject({
      kind: 'choiceResolved', complement: { kind: 'option', label: '传送至目标格，原地留下分身' },
    })
    const opponent = projectBattlePresentationEventsForViewer(authorityEvents, 'player-blue')
    expect(opponent.map(event => event.kind)).toEqual(['choiceResolved', 'concealed'])
    expect(JSON.stringify(opponent)).not.toContain('传送至目标格')
    expect(JSON.stringify(opponent)).not.toContain('teleport')

    const targetBefore = structuredClone(after)
    targetBefore.pendingTargetSelection = {
      playerId: 'player-red', targetType: 'cell', candidates: [{ type: 'cell', x: 4, y: 2 }],
      source: { type: 'skill', id: 'naruto-shadow-clone', pieceId: 'source' },
    }
    const targetAfter = structuredClone(targetBefore)
    targetAfter.pendingTargetSelection = undefined
    const targetEvents = project({
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 4, targetY: 2,
    } as BattleAction, targetBefore, targetAfter)
    expect(projectBattlePresentationEventsForViewer(targetEvents, 'player-red')[0])
      .toMatchObject({ kind: 'choiceResolved', targetCell: { x: 4, y: 2 } })
    const opponentTarget = projectBattlePresentationEventsForViewer(targetEvents, 'player-blue')
    expect(opponentTarget.map(event => event.kind)).toEqual(['choiceResolved', 'concealed'])
    expect(JSON.stringify(opponentTarget)).not.toContain('targetCell')
    expect(JSON.stringify(opponentTarget)).not.toContain('"x":4')
  })

  it('keeps Kyoka Suigetsu targets out of opponent and spectator payloads', () => {
    const before = stateWithPieces([piece('aizen', 'player-red', 10), piece('secret-ally', 'player-red', 10)])
    before.skillsById['aizen-kyoka-suiguetsu'] = {
      id: 'aizen-kyoka-suiguetsu', name: '镜花水月', kind: 'normal', cooldown: 0,
      powerMultiplier: 0, range: 'single', actionPointCost: 1, code: '',
      concealTargetInBattleLog: true,
    } as never
    const after = structuredClone(before)
    const authorityEvents = project({
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'aizen',
      skillId: 'aizen-kyoka-suiguetsu', targetPieceId: 'secret-ally',
    }, before, after)

    expect(projectBattlePresentationEventsForViewer(authorityEvents, 'player-red')[0])
      .toMatchObject({ kind: 'skill', targetPieceIds: ['secret-ally'] })
    for (const viewerId of ['player-blue', undefined]) {
      const projected = projectBattlePresentationEventsForViewer(authorityEvents, viewerId)
      expect(projected.map(event => event.kind)).toEqual(['skill', 'concealed'])
      const serialized = JSON.stringify(projected)
      expect(serialized).not.toContain('secret-ally')
      expect(serialized).not.toContain('targetPieceIds')
    }
  })

  it('collapses actor-only results to one payload-free concealed child for opponents and spectators', () => {
    const before = stateWithPieces([piece('source', 'player-red', 10), piece('target', 'player-blue', 10)])
    before.skillsById['naruto-shadow-clone'] = {
      id: 'naruto-shadow-clone', name: '影分身之术', kind: 'normal', cooldown: 0,
      powerMultiplier: 0, range: 'single', actionPointCost: 1, code: '',
      concealTargetInBattleLog: true,
    } as never
    const after = structuredClone(before)
    after.pieces[0].x = 4
    after.pieces.push(piece('clone-secret-id', 'player-red', 1) as BattleState['pieces'][number])
    after.pieces[2].x = 0
    after.pieces[2].y = 0
    const authorityEvents = project({
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'naruto-shadow-clone', targetX: 4, targetY: 0,
    }, before, after)

    const actor = projectBattlePresentationEventsForViewer(authorityEvents, 'player-red')
    const opponent = projectBattlePresentationEventsForViewer(authorityEvents, 'player-blue')
    const spectator = projectBattlePresentationEventsForViewer(authorityEvents)
    expect(actor.some(event => event.kind === 'spawn')).toBe(true)
    expect(opponent.map(event => event.kind)).toEqual(['skill', 'concealed'])
    expect(spectator).toEqual(opponent)
    const serialized = JSON.stringify(opponent)
    for (const secret of ['clone-secret-id', '"x":4', '"y":0', 'targetPieceIds', 'visibleToPlayerIds']) {
      expect(serialized).not.toContain(secret)
    }
    expect(opponent[1]).toMatchObject({ iconId: 'result-hidden', complement: { kind: 'concealed' } })

    const transportResult = {
      transition: { fromVersion: 4, toVersion: 5, playerId: 'player-red' },
      previousAuthorityState: before,
      nextAuthorityState: after,
      receipt: {
        roomId: 'red166-private-room', clientActionId: 'client-private-1',
        status: 'applied', authorityVersion: 5,
      },
      snapshot: { seed: 9 },
      presentationEvents: authorityEvents,
    } as unknown as DispatchRoomBattleActionResult
    const opponentUpdate = createPublicBattleTransitionUpdate(
      transportResult, 'red166-private-room', 'player-blue', { now: () => 2000 },
    )
    expect(opponentUpdate?.presentationEvents).toEqual(opponent)
    expect(JSON.stringify(opponentUpdate?.presentationEvents)).not.toContain('clone-secret-id')
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
