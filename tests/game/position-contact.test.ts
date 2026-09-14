import { beforeEach, describe, expect, it } from 'vitest'
import { changePiecePositions } from '@/lib/game/position-change'
import { dropChargeCrystal } from '@/lib/game/charge-crystals'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction } from '@/lib/game/turn'
import { withPositionWriteGuard, writePiecePosition } from '@/lib/game/position-write-guard'
import { traceMovementPath } from '@/lib/game/spatial'
import type { PieceInstance } from '@/lib/game/piece'
import { beginCompoundPositionContacts } from '@/lib/game/tile-contact'
import { runBattleAction } from '@/lib/game/battle-runner'
import { makePiece, makeState } from '../helpers/minimal-state'

beforeEach(() => globalTriggerSystem.clearRules())
describe('RED-209 position and contact contract', () => {
  it('cancels occupied destinations without moving or collecting', () => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0 })
    const b = makePiece({ instanceId: 'b', x: 2, y: 0 })
    const state = makeState({ pieces: [a, b] })
    dropChargeCrystal(state, { id: 'c', sourcePieceId: 'dead', x: 2, y: 0 })
    expect(changePiecePositions(state, [{ pieceId: 'a', x: 2, y: 0 }], 'teleport')).toMatchObject({ success: false })
    expect([a.x, b.x]).toEqual([0, 2])
    expect(state.players[0].chargePoints).toBe(0)
  })
  it('walk collects along the path once, excluding the origin', () => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0, moveRange: 3 })
    const state = makeState({ pieces: [a], width: 4, height: 2 })
    for (const x of [0, 1, 2, 3]) dropChargeCrystal(state, { id: `c${x}`, sourcePieceId: 'dead', x, y: 0 })
    const next = applyBattleAction(state, { type: 'move', playerId: a.ownerPlayerId, pieceId: 'a', toX: 3, toY: 0 })
    expect(next.players[0].chargePoints).toBe(3)
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.extensions?.tileEffects).toHaveLength(1)
  })
  it('teleport contacts only its destination and unchanged positions collect nothing', () => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0 })
    const state = makeState({ pieces: [a], width: 4, height: 2 })
    for (const x of [0, 1, 3]) dropChargeCrystal(state, { id: `c${x}`, sourcePieceId: 'dead', x, y: 0 })
    expect(changePiecePositions(state, [{ pieceId: 'a', x: 0, y: 0 }], 'teleport')).toMatchObject({ success: true, changes: [] })
    expect(changePiecePositions(state, [{ pieceId: 'a', x: 3, y: 0 }], 'teleport')).toMatchObject({ success: true })
    expect(state.players[0].chargePoints).toBe(1)
    expect(state.extensions?.tileEffects).toHaveLength(2)
  })
  it('swaps the complete group and credits each moved owner', () => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0 })
    const b = makePiece({ instanceId: 'b', ownerPlayerId: 'player-blue', x: 2, y: 0 })
    const state = makeState({ pieces: [a, b] })
    for (const x of [0, 2]) dropChargeCrystal(state, { id: `c${x}`, sourcePieceId: 'dead', x, y: 0 })
    expect(changePiecePositions(state, [{ pieceId: 'a', x: 2, y: 0 }, { pieceId: 'b', x: 0, y: 0 }], 'swap')).toMatchObject({ success: true })
    expect([a.x, b.x]).toEqual([2, 0])
    expect(state.players.map(p => p.chargePoints)).toEqual([1, 1])
  })

  it('keeps walk restrictions separate from teleport and swap', () => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0, statusTags: [{ id: 'root', type: 'root' }] })
    const state = makeState({ pieces: [a] })
    expect(changePiecePositions(state, [{ pieceId: 'a', x: 1, y: 0 }], 'walk').success).toBe(false)
    expect(changePiecePositions(state, [{ pieceId: 'a', x: 1, y: 0 }], 'teleport').success).toBe(true)
  })

  it('revalidates every original group member after the last before reaction', () => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0 })
    const b = makePiece({ instanceId: 'b', x: 2, y: 0 })
    const state = makeState({ pieces: [a, b] })
    globalTriggerSystem.addRule({ id: 'interrupt', name: 'interrupt', description: '', trigger: { type: 'beforePiecePositionChange' },
      effect: (_battle, context) => {
        if (context.sourcePiece?.instanceId === 'b') a.currentHp = 0
        return { success: true }
      } })
    expect(changePiecePositions(state, [{ pieceId: 'a', x: 2, y: 0 }, { pieceId: 'b', x: 0, y: 0 }], 'swap').success).toBe(false)
    expect([a.x, b.x]).toEqual([0, 2])
  })

  it('does not spend AP or emit contact when a before reaction rewrites a walk to its origin', () => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0 })
    const state = makeState({ pieces: [a] })
    globalTriggerSystem.addRule({ id: 'redirect', name: 'redirect', description: '', trigger: { type: 'beforePiecePositionChange' },
      effect: (_battle, context) => { context.targetX = 0; context.targetY = 0; return { success: true } } })
    const next = applyBattleAction(state, { type: 'move', playerId: a.ownerPlayerId, pieceId: 'a', toX: 1, toY: 0 })
    expect(next.players[0].actionPoints).toBe(state.players[0].actionPoints)
    expect(next.pieces[0].x).toBe(0)
    expect(next.actions?.some(a => a.type === 'move' || a.type === 'positionChanged')).toBe(false)
  })

  it('traces passable allies and blockers while excluding reserved landing cells', () => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0 })
    const ally = makePiece({ instanceId: 'ally', x: 1, y: 0 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 0 })
    const state = makeState({ pieces: [a, ally, enemy], width: 6, height: 2 })
    state.extensions!.tileEffects = [{ type: 'tails-flight-reservation', x: 3, y: 0 }]
    const trace = traceMovementPath(state, a, { x: 1, y: 0 }, { excludePieceId: 'a', maxDistance: 5, passAllies: true })
    expect(trace.cells).toEqual([{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }])
    expect(trace.lastLandableCell).toEqual({ x: 2, y: 0 })
    expect(trace.encounters.map(e => e.pieceId)).toEqual(['ally', 'enemy'])
    expect(trace.reachedTarget).toBe(false)
  })

  it.each(['alias', 'caught', 'replacement', 'nested'] as const)('rejects direct position writes through %s', mode => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0 })
    const state = makeState({ pieces: [a] })
    expect(() => withPositionWriteGuard(state, () => {
      if (mode === 'alias') state.pieces[0]['x'] = 1
      if (mode === 'caught') { try { a.x = 1 } catch { /* Content swallowing the error must still fail. */ } }
      if (mode === 'replacement' || mode === 'nested') {
        state.pieces[0] = { ...state.pieces[0], x: 1 }
        if (mode === 'nested') withPositionWriteGuard(state, () => undefined)
        else changePiecePositions(state, [{ pieceId: 'a', x: 2, y: 0 }], 'teleport')
      }
    })).toThrow('Use the position API')
  })

  it('allows engine placement and position APIs inside nested content without leaking descriptors', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'a', x: 0, y: 0 })] })
    withPositionWriteGuard(state, () => {
      changePiecePositions(state, [{ pieceId: 'a', x: 1, y: 0 }], 'teleport')
      const summon = makePiece({ instanceId: 'summon' }) as unknown as PieceInstance
      writePiecePosition(summon, 2, 0)
      state.pieces.push(summon)
      withPositionWriteGuard(state, () => changePiecePositions(state, [{ pieceId: 'summon', x: 3, y: 0 }], 'teleport'))
    })
    expect(structuredClone(state).pieces.map(p => p.x)).toEqual([1, 3])
    expect(Object.getOwnPropertyDescriptor(state.pieces[0], 'x')?.get).toBeUndefined()
  })

  it('protects a newly summoned piece immediately and after nested content returns', () => {
    const state = makeState()
    expect(() => withPositionWriteGuard(state, () => {
      const summon = makePiece({ instanceId: 'summon' }) as unknown as PieceInstance
      withPositionWriteGuard(state, () => { writePiecePosition(summon, 1, 0); state.pieces.push(summon) })
      summon.x = 2
      summon.x = 1
    })).toThrow('Use the position API')
  })

  it.each(['a', 'b'])('retains every pickup but defers reactions through nested scope %s', nestedId => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'a', x: 0, y: 0 })] })
    for (const x of [1, 2]) dropChargeCrystal(state, { id: `c${x}`, sourcePieceId: 'dead', x, y: 0 })
    const contacts: number[] = []
    globalTriggerSystem.addRule({ id: 'contacts', name: 'contacts', description: '', trigger: { type: 'afterPiecePathContact' },
      effect: (_battle, context) => { contacts.push(context.targetX); return { success: true } } })
    const outer = beginCompoundPositionContacts(state, ['a'])
    const inner = beginCompoundPositionContacts(state, [nestedId])
    changePiecePositions(state, [{ pieceId: 'a', x: 1, y: 0 }], 'teleport')
    changePiecePositions(state, [{ pieceId: 'a', x: 2, y: 0 }], 'teleport')
    inner.flush(); inner.cleanup()
    expect(state.players[0].chargePoints).toBe(2)
    expect(contacts).toEqual([])
    outer.flush(); outer.cleanup()
    expect(contacts).toEqual([1, 2])
  })

  it.each(['beforePiecePositionChange', 'afterPiecePathContact'] as const)('resumes interactive %s without double pickup or AP cost', type => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'a', x: 0, y: 0 })] })
    dropChargeCrystal(state, { id: 'crystal', sourcePieceId: 'dead', x: 1, y: 0 })
    globalTriggerSystem.addRule({ id: 'position-choice', name: 'position-choice', description: '', trigger: { type },
      effect: (_battle, context) => context.selectedOption === undefined
        ? { success: false, needsOptionSelection: true, options: [{ label: '继续', value: 'yes' }], title: '确认接触' }
        : { success: true } })
    const pending = runBattleAction(state, { type: 'move', playerId: 'player-red', pieceId: 'a', toX: 1, toY: 0 }, { rootSeed: 209 }).state
    expect(pending.pendingOptionSelection).toBeDefined()
    expect(pending.players[0].chargePoints).toBe(0)
    expect(pending.players[0].actionPoints).toBe(2)
    const selection = pending.pendingOptionSelection!
    const resolved = runBattleAction(pending, { type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: 'yes',
      selectionId: selection.selectionId, stateRevision: selection.stateRevision }, { rootSeed: 209 }).state
    expect(resolved.pendingOptionSelection).toBeUndefined()
    expect(resolved.players[0].chargePoints).toBe(1)
    expect(resolved.players[0].actionPoints).toBe(1)
    expect(resolved.pieces[0].x).toBe(1)
    expect(resolved.actions?.filter(a => a.type === 'chargeCrystalPickedUp')).toHaveLength(1)
  })

  it('defers the entire swap if one member belongs to a compound effect', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'a', x: 0 }), makePiece({ instanceId: 'b', x: 2 })] })
    const contacts: string[] = []
    globalTriggerSystem.addRule({ id: 'observe-swap', name: 'observe-swap', description: '', trigger: { type: 'afterPiecePositionChange' },
      effect: (_battle, context) => { contacts.push(context.sourcePiece.instanceId); return { success: true } } })
    const scope = beginCompoundPositionContacts(state, ['a'])
    changePiecePositions(state, [{ pieceId: 'a', x: 2, y: 0 }, { pieceId: 'b', x: 0, y: 0 }], 'swap')
    expect(contacts).toEqual([])
    scope.flush(); scope.cleanup()
    expect(contacts).toEqual(['a', 'b'])
  })
})
