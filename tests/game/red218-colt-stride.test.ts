import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyBattleAction } from '@/lib/game/turn'
import { loadRuleById } from '@/lib/game/skills'
import { dropChargeCrystal } from '@/lib/game/charge-crystals'
import { makePiece, makePlayer, makeState } from '../helpers/minimal-state'

function fixture(kind = 'revolver', currentPlayerId = 'player-blue') {
  const colt = makePiece({ instanceId: 'colt', templateId: 'colt', x: 1, y: 1, attack: 6 })
  colt.rules = ['rule-colt-big-stride', 'rule-colt-zone-endturn'].map(id => {
    const rule = loadRuleById(id)
    if (!rule) throw new Error(`Missing ${id}`)
    return rule
  })
  const state = makeState({ pieces: [colt,
    makePiece({ instanceId: 'old-line', ownerPlayerId: 'player-blue', x: 4, y: 1, currentHp: 20 }),
    makePiece({ instanceId: 'new-line', ownerPlayerId: 'player-blue', x: 4, y: 2, currentHp: 20 }),
  ], width: 9, height: 6, currentPlayerId })
  state.extensions!.coltZones = { colt: { sourceId: 'colt', kind, dx: 1, dy: 0, turns: 2 } }
  state.players[0].actionPoints = 0
  return state
}

function finish(pending: ReturnType<typeof makeState>, cancel = false) {
  const session = pending.pendingTargetSelection!
  expect(session).toBeDefined()
  const identity = { playerId: 'player-red', selectionId: session.selectionId, stateRevision: session.stateRevision }
  return applyBattleAction(pending, cancel ? { type: 'cancelPendingSelection', ...identity }
    : { type: 'pendingTargetSelect', ...identity, targetX: 1, targetY: 2 })
}

describe('Colt big stride before end-turn shooting', () => {
  it.each(['revolver', 'storm'])('moves first then resolves %s once from the new position', kind => {
    const state = fixture(kind)
    const pending = applyBattleAction(state, { type: 'endTurn', playerId: 'player-blue' })
    expect(pending.pendingTargetSelection).toMatchObject({ playerId: 'player-red', canCancel: true })
    expect(pending.pieces.find(p => p.instanceId === 'old-line')!.currentHp).toBe(20)
    const completed = finish(pending)
    expect(completed.pieces[0]).toMatchObject({ x: 1, y: 2 })
    expect(completed.pieces.find(p => p.instanceId === 'old-line')!.currentHp).toBe(20)
    expect(completed.pieces.find(p => p.instanceId === 'new-line')!.currentHp).toBe(14)
    expect(completed.players[0].actionPoints).toBe(0)
    expect(completed.extensions!.coltZones.colt.turns).toBe(1)
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.turn.phase).toBe('end')
  })

  it('allows cancellation and still fires from the original position', () => {
    const completed = finish(applyBattleAction(fixture(), { type: 'endTurn', playerId: 'player-blue' }), true)
    expect(completed.pieces[0]).toMatchObject({ x: 1, y: 1 })
    expect(completed.pieces.find(p => p.instanceId === 'old-line')!.currentHp).toBe(14)
    expect(completed.extensions!.coltZones.colt.turns).toBe(1)
  })

  it('survives JSON save and resume without repeating the move or shot', () => {
    const pending = applyBattleAction(fixture(), { type: 'endTurn', playerId: 'player-blue' })
    const completed = finish(JSON.parse(JSON.stringify(pending)))
    expect(completed.actions!.filter(a => a.type === 'move')).toHaveLength(1)
    expect(completed.pieces.find(p => p.instanceId === 'new-line')!.currentHp).toBe(14)
    expect(completed.extensions!.coltZones.colt.turns).toBe(1)
  })

  it('resumes two allied Colts in sequence without repeating earlier movement or shooting', () => {
    const state = fixture()
    state.pieces.push({ ...state.pieces[0], instanceId: 'colt-two', x: 2, y: 3,
      rules: state.pieces[0].rules!.map(rule => ({ ...rule })) })
    const first = applyBattleAction(state, { type: 'endTurn', playerId: 'player-blue' })
    const second = finish(first)
    expect(second.pendingTargetSelection?.source?.pieceId).toBe('colt-two')
    const session = second.pendingTargetSelection!
    const completed = applyBattleAction(second, { type: 'pendingTargetSelect', playerId: 'player-red',
      selectionId: session.selectionId, stateRevision: session.stateRevision, targetX: 2, targetY: 4 })
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.pieces.find(p => p.instanceId === 'colt')).toMatchObject({ x: 1, y: 2 })
    expect(completed.pieces.find(p => p.instanceId === 'colt-two')).toMatchObject({ x: 2, y: 4 })
    expect(completed.actions!.filter(a => a.type === 'move')).toHaveLength(2)
    expect(completed.pieces.find(p => p.instanceId === 'new-line')!.currentHp).toBe(14)
    expect(completed.extensions!.coltZones.colt.turns).toBe(1)
  })

  it('skips the choice on the owner turn and still resolves the zone', () => {
    const next = applyBattleAction(fixture('revolver', 'player-red'), { type: 'endTurn', playerId: 'player-red' })
    expect(next.pendingTargetSelection).toBeUndefined()
    expect(next.pieces.find(p => p.instanceId === 'old-line')!.currentHp).toBe(14)
  })

  it('does not trigger at an allied teammate turn end', () => {
    const state = fixture('revolver', 'teammate')
    state.players[0].teamId = 'red'
    state.players[1].teamId = 'blue'
    state.players.push({ ...makePlayer('teammate', 'red'), teamId: 'red' })
    const next = applyBattleAction(state, { type: 'endTurn', playerId: 'teammate' })
    expect(next.pendingTargetSelection).toBeUndefined()
  })

  it('grants movement without an active zone and collects path crystals once', () => {
    const state = fixture()
    delete state.extensions!.coltZones
    dropChargeCrystal(state, { id: 'path-crystal', sourcePieceId: 'fallen', x: 1, y: 2 })
    const pending = applyBattleAction(state, { type: 'endTurn', playerId: 'player-blue' })
    const session = pending.pendingTargetSelection!
    const next = applyBattleAction(pending, { type: 'pendingTargetSelect', playerId: 'player-red',
      selectionId: session.selectionId, stateRevision: session.stateRevision, targetX: 1, targetY: 3 })
    expect(next.pieces[0]).toMatchObject({ x: 1, y: 3 })
    expect(next.players[0].chargePoints).toBe(1)
    expect(next.actions!.filter(a => a.type === 'chargeCrystalPickedUp')).toHaveLength(1)
  })

  it('offers only ordinary movement cells up to the current range and stops at pieces and walls', () => {
    const state = fixture()
    state.pieces[0].moveRange = 2
    state.pieces.push({ ...state.pieces[1], instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1 })
    state.map.tiles.find(t => t.x === 1 && t.y === 0)!.props.walkable = false
    const pending = applyBattleAction(state, { type: 'endTurn', playerId: 'player-blue' })
    expect(pending.pendingTargetSelection!.candidates).toEqual(expect.arrayContaining([
      { type: 'cell', x: 1, y: 3 }, { type: 'cell', x: 0, y: 1 },
    ]))
    for (const cell of [{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 4 }]) {
      expect(pending.pendingTargetSelection!.candidates).not.toContainEqual({ type: 'cell', ...cell })
    }
  })

  it('does not offer blocked paths or movement while immobilized', () => {
    const state = fixture()
    state.pieces[0].statusTags = [{ id: 'root', type: 'root', currentDuration: 2 }]
    const next = applyBattleAction(state, { type: 'endTurn', playerId: 'player-blue' })
    expect(next.pendingTargetSelection).toBeUndefined()
    expect(next.pieces.find(p => p.instanceId === 'old-line')!.currentHp).toBe(14)
  })

  it('registers the passive and places its rule ahead of the shooting rule', () => {
    const read = (path: string) => JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
    const colt = read('data/pieces/colt.json')
    expect(colt.skills.some((s: { skillId: string }) => s.skillId === 'colt-big-stride')).toBe(true)
    expect(colt.rules.indexOf('rule-colt-big-stride')).toBeLessThan(colt.rules.indexOf('rule-colt-zone-endturn'))
    expect(read('data/skills/manifest.json')).toContain('colt-big-stride')
    expect(read('data/rules/manifest.json')).toContain('rule-colt-big-stride')
  })
})
