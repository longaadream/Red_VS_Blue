import { describe, expect, it } from 'vitest'
import { createShadowState } from '@/lib/ai-bot/shadow-state'
import type { BattleState } from '@/lib/game/turn'

function snapshot(): BattleState {
  return {
    map: {
      id: 'map',
      name: 'Map',
      width: 3,
      height: 1,
      tiles: [
        { id: 'map-0-0', x: 0, y: 0, props: { walkable: true, bulletPassable: true, type: 'floor' } },
        { id: 'map-1-0', x: 1, y: 0, props: { walkable: true, bulletPassable: true, type: 'floor' } },
        { id: 'map-2-0', x: 2, y: 0, props: { walkable: true, bulletPassable: true, type: 'floor' } },
      ],
      rules: [{ secret: 'map-rule' }],
    },
    pieces: [
      {
        instanceId: 'red-1', templateId: 'unknown-red', name: 'Red', ownerPlayerId: 'red', faction: 'red',
        currentHp: 10, maxHp: 10, attack: 2, defense: 1, moveRange: 2, x: 0, y: 0,
        isCore: true, skills: [{ skillId: 'missing-skill', currentCooldown: 0 }],
        buffs: [{ type: 'visible-buff', value: 1, duration: 2, source: 'red-1' }], debuffs: [],
        ruleTags: ['network-rule'], rules: [{ id: 'network-rule', effect: 'server code' }],
        statusTags: [{ id: 'private', type: 'private', visible: false, relatedRules: ['secret-rule'] }, { id: 'public', type: 'public', stacks: 2 }],
      },
      {
        instanceId: 'blue-1', templateId: 'unknown-blue', name: 'Blue', ownerPlayerId: 'blue', faction: 'blue',
        currentHp: 8, maxHp: 8, attack: 3, defense: 1, moveRange: 2, x: 2, y: 0,
        isCore: true, skills: [], buffs: [], debuffs: [], ruleTags: [], rules: [],
        statusTags: [{ id: 'hidden', type: 'hidden', visible: false }, { id: 'public', type: 'public' }],
      },
    ],
    graveyard: [],
    pieceStatsByTemplateId: { 'network-red': { maxHp: 999, attack: 999, defense: 999, moveRange: 99 } },
    skillsById: { 'network-skill': { id: 'network-skill', name: 'Network', kind: 'active', code: 'server code' } as never },
    players: [
      {
        playerId: 'red', chargePoints: 1, actionPoints: 3, maxActionPoints: 3,
        hand: [{ cardId: 'card-a', instanceId: 'card-a-1', ownerPlayerId: 'red', contentState: { secret: true }, actionPointCost: 1 }],
        discardPile: [], rules: [{ id: 'network-player-rule', effect: 'server code' }], statusTags: [],
      },
      {
        playerId: 'blue', chargePoints: 0, actionPoints: 0, maxActionPoints: 0,
        hand: [{ cardId: 'secret-card', instanceId: 'secret-card-1', ownerPlayerId: 'blue' }],
        discardPile: ['public-discard'], rules: [], statusTags: [],
      },
    ],
    turn: { currentPlayerId: 'red', turnNumber: 1, phase: 'action', actions: { hasMoved: false, hasUsedBasicSkill: false, hasUsedChargeSkill: false } },
    targetingRevision: 7,
    extensions: {
      debugBattle: { replay: { hidden: true } },
      battleProfile: { rootSeed: 987654 },
      seed: 987654,
      cursor: 14,
      tileEffects: [{ id: 'public-but-extension', x: 1, y: 0, type: 'fire', privatePayload: 'drop' }],
    },
    customCards: { 'card-a': { code: 'server code' } },
    actions: [{ type: 'secret-log', playerId: 'blue', turn: 1 }],
    turnTimer: { status: 'running' } as never,
    deployment: {
      mode: 'progressive-reserve-v1', status: 'awaiting-reserve-deploy', playerIds: ['red', 'blue'],
      choices: {}, locks: {}, startedAt: 0, deadlineAt: 1000, revision: 3,
      initialPositions: {}, activePlayerId: 'red', offerTurnNumber: 1,
      reserves: { red: [{ instanceId: 'hidden-reserve', templateId: 'hidden', name: 'hidden' }] as never[] },
      offerPieceIds: ['hidden-reserve'],
      offerPieces: [{ instanceId: 'offer-1', templateId: 'public-template', name: 'Offer' }],
      legalPositions: [{ x: 1, y: 0 }],
    },
    pendingOptionSelection: {
      playerId: 'red', title: 'Choose', options: [{ value: 'public-choice', label: 'Public', private: 'drop' }],
      selectionId: 'option-1', stateRevision: 7, canCancel: true,
      pendingAction: { code: 'drop' }, continuationContext: { hidden: true },
    } as never,
  } as unknown as BattleState
}

describe('createShadowState', () => {
  it('projects only player-visible fields and never forwards source extensions or continuations', () => {
    const source = snapshot()
    const before = JSON.stringify(source)
    const result = createShadowState(source, 'red')
    const state = result.state as BattleState & Record<string, unknown>

    expect(state.extensions).toBeUndefined()
    expect(state.customCards).toBeUndefined()
    expect(state.actions).toBeUndefined()
    expect(state.turnTimer).toBeUndefined()
    expect(state.players[0].hand).toHaveLength(1)
    expect(state.players[0].hand[0]).not.toHaveProperty('contentState')
    expect(state.players[1].hand).toEqual([])
    expect(state.pieces[0].statusTags).toEqual([
      { id: 'private', type: 'private', visible: false },
      { id: 'public', type: 'public', stacks: 2 },
    ])
    expect(state.pieces[1].statusTags).toEqual([{ id: 'public', type: 'public' }])
    expect(state.deployment?.reserves).toBeUndefined()
    expect(state.deployment?.offerPieceIds).toBeUndefined()
    expect(state.pendingOptionSelection).toMatchObject({
      selectionId: 'option-1', stateRevision: 7, options: [{ value: 'public-choice', label: 'Public' }],
    })
    expect(state.pendingOptionSelection).not.toHaveProperty('pendingAction')
    expect(state.pendingOptionSelection).not.toHaveProperty('continuationContext')
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('network extensions'),
      expect.stringContaining('pending option continuation'),
      expect.stringContaining('private card content state'),
      expect.stringContaining('dynamic status rule metadata'),
    ]))
    expect(JSON.stringify(source)).toBe(before)
  })

  it('keeps deployment offers and pending metadata scoped to the requesting player', () => {
    const source = snapshot()
    const mutable = source as unknown as {
      deployment: { activePlayerId: string; choices: Record<string, { pieceId: string }> }
      pendingOptionSelection: {
        playerId: string
        selectionMode: 'single' | 'multi'
        minSelections: number
        maxSelections: number
        options: unknown[]
      }
    }
    mutable.deployment.activePlayerId = 'blue'
    mutable.deployment.choices = { blue: { pieceId: 'blue-1' } }
    mutable.pendingOptionSelection.playerId = 'blue'
    mutable.pendingOptionSelection.selectionMode = 'multi'
    mutable.pendingOptionSelection.minSelections = 2
    mutable.pendingOptionSelection.maxSelections = 2
    mutable.pendingOptionSelection.options = [{ value: 'secret-choice', private: true }]

    const result = createShadowState(source, 'red')
    expect(result.state.deployment?.offerPieces).toBeUndefined()
    expect(result.state.deployment?.legalPositions).toBeUndefined()
    expect(result.state.deployment?.choices).toEqual({})
    expect(result.state.pendingOptionSelection?.options).toEqual([])
    expect(result.state.pendingOptionSelection).not.toHaveProperty('selectionMode')
    expect(result.state.pendingOptionSelection).not.toHaveProperty('minSelections')
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('another player deployment offers'),
      expect.stringContaining('another player pending option atoms'),
    ]))
  })

  it('is independent from hidden source changes while preserving the public projection', () => {
    const first = snapshot()
    const second = snapshot()
    const secondRecord = second as unknown as {
      extensions: {
        battleProfile: { rootSeed: number }
        debugBattle: { replay: { hidden: boolean } }
      }
      players: Array<{ hand: Array<Record<string, unknown>> }>
      pieces: Array<{ statusTags: Array<Record<string, unknown>> }>
      pieceStatsByTemplateId: Record<string, Record<string, unknown>>
      skillsById: Record<string, Record<string, unknown>>
    }
    secondRecord.extensions.battleProfile.rootSeed = 123
    secondRecord.extensions.debugBattle.replay.hidden = false
    secondRecord.players[1].hand[0].cardId = 'different-secret-card'
    secondRecord.pieces[1].statusTags[0].type = 'different-hidden-status'
    secondRecord.pieceStatsByTemplateId['network-red'].attack = 1
    secondRecord.skillsById['network-skill'].code = 'different code'

    const left = createShadowState(first, 'red')
    const right = createShadowState(second, 'red')
    expect(JSON.stringify(left.state)).toBe(JSON.stringify(right.state))
    expect(left.diagnostics).toEqual(right.diagnostics)
  })
})
