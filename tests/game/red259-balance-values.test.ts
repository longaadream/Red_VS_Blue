/* eslint-disable @typescript-eslint/no-explicit-any -- RED-259 exercises JSON-authored content through the battle reducer. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hashStable, runBattleAction } from '@/lib/game/battle-runner'
import { getPieceById } from '@/lib/game/piece-repository'
import { prepareAction } from '@/lib/game/targeting'
import { applyBattleAction, type BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')
const BANKAI_ID = 'ichigo-bankai-tensa-zangetsu'
const BLESSING_ID = 'elune-blessing'
const EXPEDITION_ID = 'turalyon-expedition-order'
const ROOT_SEED = 259

function loadJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(DATA_ROOT, ...segments), 'utf8')) as T
}

function loadSkill(id: string): any {
  return loadJson('skills', `${id}.json`)
}

function makeIchigoState(chargePoints: number): BattleState {
  const ichigo = makePiece({
    instanceId: 'ichigo',
    templateId: 'blue-ichigo',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
    attack: 5,
    moveRange: 4,
  }) as any
  ichigo.skills = [{ skillId: BANKAI_ID, currentCooldown: 0, usesRemaining: -1 }]
  const state = makeState({ pieces: [ichigo] }) as any
  state.skillsById[BANKAI_ID] = loadSkill(BANKAI_ID)
  state.players[0].actionPoints = 2
  state.players[0].chargePoints = chargePoints
  return state
}

function makeBlessingState(cardId: string): BattleState {
  const tyrande = makePiece({
    instanceId: 'tyrande',
    templateId: 'tyrande',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
    currentHp: 5,
    maxHp: 30,
    attack: 4,
    moveRange: 3,
  }) as any
  tyrande.name = '泰兰德'
  tyrande.skills = [{ skillId: BLESSING_ID, currentCooldown: 0, usesRemaining: -1 }]
  const pieces: any[] = [tyrande]
  if (cardId === 'holy-smite') {
    pieces.push(makePiece({
      instanceId: 'enemy',
      templateId: 'enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 0,
      currentHp: 20,
      maxHp: 20,
    }) as any)
  }
  const state = makeState({ pieces }) as any
  state.skillsById[BLESSING_ID] = loadSkill(BLESSING_ID)
  state.players[0].actionPoints = 3
  state.players[0].hand = []
  return state
}

function playBlessedCard(cardId: string): any {
  let state = makeBlessingState(cardId)
  state = runBattleAction(state, {
    type: 'useBasicSkill',
    playerId: 'player-red',
    pieceId: 'tyrande',
    skillId: BLESSING_ID,
  }, { rootSeed: ROOT_SEED }).state as any

  const blessingLog = (state.actions ?? []).find((entry: any) => (
    entry.type === 'useBasicSkill' && entry.payload?.skillId === BLESSING_ID
  ))
  expect(blessingLog?.payload?.message).toContain('提高50%')
  expect(state.pieces.find((piece: any) => piece.instanceId === 'tyrande')?.skills[0])
    .toMatchObject({ skillId: BLESSING_ID, currentCooldown: 2 })

  state.players[0].hand.push({
    cardId,
    instanceId: 'blessed-card',
    ownerPlayerId: 'player-red',
    actionPointCost: 1,
  })
  return runBattleAction(state, {
    type: 'playCard',
    playerId: 'player-red',
    cardInstanceId: 'blessed-card',
  }, { rootSeed: ROOT_SEED }).state as any
}

describe('RED-259 holy-light balance values', () => {
  it('pins the new costs, multiplier text, and Velen skill roster', () => {
    expect(loadSkill(BANKAI_ID)).toMatchObject({ chargeCost: 2 })

    const blessing = loadSkill(BLESSING_ID)
    expect(blessing).toMatchObject({ cooldownTurns: 2, powerMultiplier: 1.5 })
    expect(blessing.description).toBe('获得1张随机圣光手牌。下张打出的圣光手牌效果提高50%。')
    expect(blessing.previewCode).toContain(blessing.description)
    expect(blessing.code).toContain("multiplier: 1.5")
    expect(blessing.code).toContain('效果提高50%')

    const velen = loadJson<any>('pieces', 'velen.json')
    expect(velen.skills.map((entry: any) => entry.skillId)).toEqual([
      'velen-holy-prophecy',
      'velen-fate-shelter',
      'velen-thousand-futures-ultimate',
      EXPEDITION_ID,
    ])
  })

  it('rejects Bankai below 2 CP without mutation and spends exactly 2 CP', () => {
    const action = {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: 'ichigo',
      skillId: BANKAI_ID,
    } as any
    const insufficient = makeIchigoState(1)
    const before = hashStable(insufficient)
    expect(() => runBattleAction(insufficient, action, { rootSeed: ROOT_SEED })).toThrow()
    expect(hashStable(insufficient)).toBe(before)

    const sufficient = makeIchigoState(2)
    const resolved = runBattleAction(sufficient, action, { rootSeed: ROOT_SEED }).state as any
    expect(resolved.players[0].chargePoints).toBe(0)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'ichigo'))
      .toMatchObject({ attack: 6, moveRange: 6 })
  })

  it('applies the 50% blessing multiplier once to each holy card', () => {
    for (const cardId of ['holy-smite', 'holy-heal', 'holy-charge']) {
      const resolved = playBlessedCard(cardId)
      const player = resolved.players[0]
      expect(player.buffs['elune-blessing-buff']).toMatchObject({ multiplier: 1.5, uses: 0 })

      if (cardId === 'holy-smite') {
        expect(resolved.pieces.find((piece: any) => piece.instanceId === 'enemy')?.currentHp).toBe(13)
      } else if (cardId === 'holy-heal') {
        expect(resolved.pieces.find((piece: any) => piece.instanceId === 'tyrande')?.currentHp).toBe(17)
      } else {
        expect(resolved.pieces.find((piece: any) => piece.instanceId === 'tyrande')?.statusTags)
          .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'damage-buff', intensity: 3 })]))
      }
    }
  })

  it('does not apply the blessing to the second holy card', () => {
    const first = playBlessedCard('holy-smite')
    first.players[0].hand.push({
      cardId: 'holy-smite',
      instanceId: 'second-smite',
      ownerPlayerId: 'player-red',
      actionPointCost: 1,
    })
    const second = runBattleAction(first, {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'second-smite',
    }, { rootSeed: ROOT_SEED }).state as any
    expect(second.players[0].buffs['elune-blessing-buff']).toMatchObject({ multiplier: 1.5, uses: 0 })
    expect(second.pieces.find((piece: any) => piece.instanceId === 'enemy')?.currentHp).toBe(8)
  })

  it.each(['holy-smite', 'holy-heal', 'holy-charge'])('loads Velen with four skills and obtains exactly the selected %s', (choice) => {
    const template = getPieceById('velen')!
    expect(template.skills.map((entry: any) => entry.skillId)).toContain(EXPEDITION_ID)
    expect(template.skills).toHaveLength(4)

    const velen = makePiece({
      instanceId: 'velen',
      templateId: 'velen',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
    }) as any
    velen.skills = template.skills.map((entry: any) => ({
      skillId: entry.skillId,
      currentCooldown: 0,
      usesRemaining: -1,
    }))
    const state = makeState({ pieces: [velen] }) as any
    state.skillsById[EXPEDITION_ID] = loadSkill(EXPEDITION_ID)
    state.players[0].actionPoints = 2
    state.players[0].hand = [{ cardId: 'holy-smite', instanceId: 'existing', ownerPlayerId: 'player-red' }]
    const base = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'velen',
      skillId: EXPEDITION_ID,
    } as any

    const prepared = prepareAction(state, base)
    expect(prepared.kind).toBe('needOption')
    if (prepared.kind !== 'needOption') throw new Error('Expected Expedition Order option selection')
    expect(prepared.options).toEqual([
      { label: '圣光惩戒', value: 'holy-smite' },
      { label: '圣光治疗', value: 'holy-heal' },
      { label: '圣光充能', value: 'holy-charge' },
    ])
    const resolved = applyBattleAction(state, {
      ...base,
      selectedOption: choice,
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    } as any) as any

    expect(resolved.players[0].hand.map((card: any) => card.cardId)).toEqual(['holy-smite', choice])
    expect(resolved.players[0].actionPoints).toBe(1)
    expect(resolved.pieces[0].skills.find((entry: any) => entry.skillId === EXPEDITION_ID))
      .toMatchObject({ currentCooldown: 2 })
    expect(loadSkill(EXPEDITION_ID)).toMatchObject({ actionPointCost: 1, cooldownTurns: 2 })
  })
})
