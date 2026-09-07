/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise JSON-authored rules through production battle fixtures. */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import { dropChargeCrystal } from '@/lib/game/charge-crystals'
import type { PieceTemplate } from '@/lib/game/piece'
import { dealDamage, loadAllSkillsById, loadRuleById } from '@/lib/game/skills'
import { finalizePendingTargetSession, validatePendingTargetSubmissions, prepareAction, targetRefKey } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const load = (group: string, id: string) => JSON.parse(readFileSync(`data/${group}/${id}.json`, 'utf8'))
const piece = (id: string): PieceTemplate => load('pieces', id)
beforeEach(() => globalTriggerSystem.clearRules())

async function opening(seed = 189, roster = [piece('blue-naruto'), piece('guldan')]) {
  roster = [...roster, ...Array.from({ length: 8 - roster.length }, (_, i): PieceTemplate => ({
    id: `filler-${i}`, name: `Filler ${i}`, faction: 'good', rarity: 'common', skills: [],
    stats: { maxHp: 20, attack: 2, defense: 0, moveRange: 3 },
  }))]
  const result = await createInitialBattleForPlayers(['red', 'blue'], roster, [
    { playerId: 'red', pieces: roster, faction: 'red' },
    { playerId: 'blue', pieces: roster, faction: 'blue' },
  ], 'large-hole-arena', {
    firstPlayerId: 'red', rootSeed: seed, deploymentEnabled: true, deploymentStartedAt: 1750000000000,
  })
  if (!result) throw new Error('Missing battle')
  return result
}

function transportFixture() {
  const state = makeState({ width: 10, height: 4, pieces: [
    makePiece({ instanceId: 'obito', x: 0, y: 0 }),
    makePiece({ instanceId: 'ally', x: 2, y: 0 }),
    makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 9, y: 0 }),
  ] })
  state.skillsById = loadAllSkillsById()
  state.pieces[0].skills = [{ skillId: 'obito-ally-teleport', currentCooldown: 0, usesRemaining: -1 }]
  return state
}
const transfer = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'obito', skillId: 'obito-ally-teleport' } as const

function transferCommand(state: any, x = 6, y = 1) {
  const ready = prepareAction(state, transfer)
  if (ready.kind !== 'needTarget') throw new Error(`Expected ally choice: ${ready.kind}`)
  return { ...transfer, targetPieceId: 'ally', extraTargets: [{ x, y }],
    selectionId: ready.selectionId, stateRevision: ready.stateRevision } as any
}

describe('RED-189 opening and whole-match effects', () => {
  it.each([189, 190, 191])('always opens with Naruto on both sides for seed %s, keeping the first reinforcement', async seed => {
    const state = await opening(seed)
    expect(state.pieces.map(p => p.templateId)).toEqual(['blue-naruto', 'blue-naruto'])
    expect(state.pieces.every(p => p.isCore)).toBe(true)
    expect(state.pieces.flatMap(p => p.statusTags)).not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
    expect(state.deployment).toMatchObject({ status: 'awaiting-reserve-deploy', reserveCounts: { red: 7, blue: 7 } })
    expect(hashBattleState(await opening(seed))).toBe(hashBattleState(state))
    expect(state.deployment!.reserves!.red.some(p => p.templateId === 'guldan')).toBe(true)
    expect(piece('blue-naruto').skills).toContainEqual(expect.objectContaining({ skillId: 'naruto-vanguard' }))
  })

  it('meditates without blocking damage and still grants 3 AP and 1 CP on completion', () => {
    const state = transportFixture()
    state.pieces[0].skills = [{ skillId: 'naruto-sage-mode', currentCooldown: 0, usesRemaining: -1 }]
    const result = runBattleAction(state, { ...transfer, skillId: 'naruto-sage-mode' }, { rootSeed: 189 }).state
    const naruto = result.pieces[0]
    expect(naruto.statusTags.some(t => t.type === 'sage-mode-shield')).toBe(false)
    expect(naruto.rules.some(r => r.id === 'rule-naruto-sage-immunity')).toBe(false)
    expect(naruto.statusTags.find(t => t.type === 'sage-mode')).toMatchObject({ stacks: 6 })
    const hp = naruto.currentHp
    dealDamage(result.pieces[2], naruto, 2, 'true', result, 'test-damage')
    expect(naruto.currentHp).toBe(hp - 2)
    const ap = result.players[0].actionPoints
    const cp = result.players[0].chargePoints
    for (let turn = 0; turn < 6; turn++) globalTriggerSystem.checkTriggers(result, { type: 'beginTurn', playerId: naruto.ownerPlayerId } as any)
    expect(naruto.statusTags.some(t => t.type === 'sage-mode')).toBe(false)
    expect(result.players[0].actionPoints).toBe(ap + 3)
    expect(result.players[0].chargePoints).toBe(cp + 1)
  })

  it('uses template priority rather than the Naruto ID', async () => {
    const custom = { ...piece('blue-naruto'), id: 'custom-vanguard', name: 'Custom vanguard' }
    const state = await opening(192, [custom, piece('guldan')])
    expect(state.pieces.every(p => p.templateId === 'custom-vanguard')).toBe(true)
  })

  it('shares the opening passive with an unrelated template without template flags', async () => {
    const custom = { ...piece('guldan'), id: 'shared-passive-user', skills: [{ skillId: 'naruto-vanguard', level: 1 }] }
    const state = await opening(192, [custom])
    expect(state.pieces.every(p => p.templateId === custom.id)).toBe(true)
    expect(load('skills', 'naruto-vanguard').description).toBe('当阵容中有本棋子时，本棋子首先上场。')
  })

  it('selects only one priority character per owner, leaving the others in reserve', async () => {
    const roster = [piece('blue-naruto'), { ...piece('blue-naruto'), id: 'custom-vanguard', name: 'Custom vanguard' }]
    const selected = new Set<string>()
    for (const seed of [189, 190, 191, 192, 193, 194, 195, 196]) {
      const state = await opening(seed, roster)
      expect(hashBattleState(await opening(seed, roster))).toBe(hashBattleState(state))
      for (const owner of ['red', 'blue']) {
        const deployed = state.pieces.filter(p => p.ownerPlayerId === owner)
        expect(deployed).toHaveLength(1)
        expect(roster.map(p => p.id)).toContain(deployed[0].templateId)
        selected.add(deployed[0].templateId)
        const reserve = state.deployment!.reserves![owner]
        expect(reserve).toHaveLength(7)
        expect(reserve.filter(p => roster.some(template => template.id === p.templateId))).toHaveLength(1)
      }
    }
    expect([...selected].sort()).toEqual(['blue-naruto', 'custom-vanguard'])
  })

  it('grants one independent player rule per owner while Guldan is still in reserve and after his death', async () => {
    const state = await opening()
    const fragments = () => state.players.map(p => p.hand.filter(c => c.cardId === 'soul-fragment').length)
    expect(state.players.map(p => p.rules!.filter(r => r.id === 'rule-soul-fracture-player').length)).toEqual([1, 1])
    const summon = { ...state.pieces[0], instanceId: 'summon', isCore: false, x: 0, y: 0, currentHp: 1, rules: [], statusTags: [] }
    state.pieces.push(summon)
    dealDamage(state.pieces[0], summon, 100, 'true', state, 'test-damage')
    expect(fragments()).toEqual([1, 1])
    // Stage the later on-board death using the same initialized stable Guldan instance.
    const reserve = state.deployment!.reserves!.red
    const [guldan] = reserve.splice(reserve.findIndex(p => p.templateId === 'guldan'), 1)
    guldan.x = 0
    guldan.y = 0
    state.pieces.push(guldan)
    expect(guldan.rules.some(r => r.id === 'rule-soul-fracture')).toBe(false)
    dealDamage(state.pieces.find(p => p.ownerPlayerId === 'blue')!, guldan, 100, 'true', state, 'test-damage')
    expect(fragments()).toEqual([2, 2])
    const nextSummon = { ...summon, instanceId: 'next-summon', currentHp: 1 }
    state.pieces.push(nextSummon)
    dealDamage(state.pieces[0], nextSummon, 100, 'true', state, 'test-damage')
    expect(fragments()).toEqual([3, 3])
  })
})

describe('RED-189 Obito and Doomfist', () => {
  it('keeps only ally transfer and the existing force removal skill on Obito', () => {
    expect(piece('red-obito').skills.map(s => s.skillId)).toEqual(['obito-ally-teleport', 'obito-space-time'])
    expect(load('skills', 'obito-space-time')).toMatchObject({ actionPointCost: 5, chargeCost: 3 })
  })

  it('transports the ally immediately across terrain and charges the caster once', () => {
    const state = transportFixture()
    const freeMove = { id: 'free-move', type: 'deployment-first-move-free', currentUses: 1, grantedTurnNumber: 1 }
    state.pieces[1].statusTags.push(freeMove)
    const crystal = dropChargeCrystal(state, { id: 'test-crystal', sourcePieceId: 'fallen', x: 6, y: 1 })
    state.map.tiles.find(t => t.x === 3 && t.y === 0)!.props.walkable = false
    const resolved = runBattleAction(state, transferCommand(state), { rootSeed: 189 }).state
    expect(resolved.pieces[0]).toMatchObject({ x: 0, y: 0 })
    expect(resolved.pieces[1]).toMatchObject({ x: 6, y: 1 })
    expect(resolved.players[0].actionPoints).toBe(1)
    expect(resolved.pieces[0].skills[0].currentCooldown).toBe(3)
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pieces[1].statusTags).toContainEqual(freeMove)
    expect(resolved.players[0].chargePoints).toBe(0)
    expect(resolved.extensions!.tileEffects).toContainEqual(crystal)
  })

  it('rejects a reserved landing without applying a partial transfer', () => {
    const state = transportFixture()
    state.extensions!.tileEffects = [{ type: 'tails-flight-reservation', x: 6, y: 1 }]
    const selecting = transferCommand(state)
    delete selecting.extraTargets
    const prepared = prepareAction(state, selecting)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind === 'needTarget') expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 6, y: 1 })
    const before = structuredClone(state)
    expect(() => runBattleAction(state, transferCommand(state), { rootSeed: 189 })).toThrow()
    expect(state).toEqual(before)
  })

  it('preserves reserved-cell exclusion in pending sessions', () => {
    const state = transportFixture()
    state.extensions!.tileEffects = [{ type: 'tails-flight-reservation', x: 6, y: 1 }]
    const pending = finalizePendingTargetSession(state, {
      playerId: 'player-red', source: { type: 'skill', id: 'obito-ally-teleport', pieceId: 'obito' },
      targetType: 'grid', steps: [{ type: 'grid', range: 7, filter: 'all', requireWalkable: true,
        requireUnoccupied: true, forbiddenTileEffectTypes: ['tails-flight-reservation'] }],
    } as any, 0)
    expect(pending.candidates).not.toContainEqual({ type: 'cell', x: 6, y: 1 })
    state.pendingTargetSelection = pending
    expect(() => validatePendingTargetSubmissions(state, { playerId: 'player-red',
      selectionId: pending.selectionId, stateRevision: pending.stateRevision, targetX: 6, targetY: 1,
    })).toThrow()
  })

  it('only prepares the second destination selection without committing the first choice', () => {
    const state = transportFixture()
    const command = transferCommand(state)
    delete command.extraTargets
    const before = structuredClone(state)
    expect(prepareAction(state, command)).toMatchObject({ kind: 'needTarget', step: 1, canCancel: true })
    expect(state).toEqual(before)
  })

  it('gives fragments for each death in a batch but none for force removal', () => {
    const state = transportFixture()
    for (const owner of state.players) owner.rules = [loadRuleById('rule-soul-fracture-player', true)]
    const victims = [3, 4].map((x, i) => ({ ...state.pieces[2], instanceId: `victim-${i}`, x, currentHp: 1, isCore: false }))
    state.pieces.push(...victims)
    dealDamage(state.pieces[0], victims, 100, 'true', state, 'test-damage')
    expect(state.players.map(p => p.hand.filter(c => c.cardId === 'soul-fragment').length)).toEqual([2, 2])
    state.pieces[0].skills = [{ skillId: 'obito-space-time', currentCooldown: 0, usesRemaining: 1 }]
    state.players[0].actionPoints = 5
    state.players[0].chargePoints = 3
    const base = { ...transfer, type: 'useChargeSkill', skillId: 'obito-space-time' } as const
    const prepared = prepareAction(state, base)
    if (prepared.kind !== 'needTarget') throw new Error('Expected removal target')
    const result = runBattleAction(state, { ...base, targetPieceId: 'enemy',
      selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }, { rootSeed: 189 }).state
    expect(result.pieces.some(p => p.instanceId === 'enemy')).toBe(false)
    expect(result.players.map(p => p.hand.filter(c => c.cardId === 'soul-fragment').length)).toEqual([2, 2])
  })

  it('excludes self, enemies, distant and imprisoned allies', () => {
    const state = transportFixture()
    const getTargets = () => {
      const result = prepareAction(state, transfer)
      if (result.kind !== 'needTarget') throw new Error('Expected targets')
      return result.candidates.map(targetRefKey)
    }
    expect(getTargets()).toEqual(['piece:ally'])
    state.pieces[1].x = 8
    expect(getTargets()).toEqual([])
    state.pieces[1].x = 2
    state.pieces[1].statusTags.push({ id: 'test-root', type: 'imprisoned' })
    expect(getTargets()).toEqual([])
  })

  it.each([[2, 0], [8, 0], [3, 0]])('rejects an occupied, distant or blocked landing (%s,%s) without mutations', (x, y) => {
    const state = transportFixture()
    state.map.tiles.find(t => t.x === 3 && t.y === 0)!.props.walkable = false
    const command = transferCommand(state, x, y)
    const before = structuredClone(state)
    expect(() => runBattleAction(state, command, { rootSeed: 189 })).toThrow()
    expect(state).toEqual(before)
  })

  it('keeps only punch and ultimate on Doomfist and applies the 250% multiplier', () => {
    expect(piece('red-doomsday-fist').skills.map(s => s.skillId)).toEqual(['rocket-punch', 'earthshatter'])
    const state = transportFixture()
    state.pieces[0].attack = 2
    state.pieces[0].skills = [{ skillId: 'rocket-punch', currentCooldown: 0, usesRemaining: -1 }]
    state.pieces[1].x = 0
    state.pieces[1].y = 3
    state.pieces[2].x = 3
    const base = { ...transfer, skillId: 'rocket-punch' }
    const prepared = prepareAction(state, base)
    if (prepared.kind !== 'needTarget') throw new Error('Missing direction')
    const result = runBattleAction(state, { ...base, targetX: 5, targetY: 0,
      selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }, { rootSeed: 189 }).state
    expect(result.pieces[2].currentHp).toBe(95)
    expect(result.pieces[0]).toMatchObject({ x: 2, y: 0 })
  })
})
