import { describe, expect, it } from 'vitest'
import {
  recordBattlePresentation,
  recordedProjectilePaths,
  presentationRecordingRollback,
} from '@/lib/game/battle-presentation-recording'
import { createFlowRuntime } from '@/lib/game/flow-runtime'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function runObserved(state: BattleState, run: (flow: ReturnType<typeof createFlowRuntime>) => void) {
  return recordBattlePresentation(state, () => {
    run(createFlowRuntime(state, { piece: state.pieces[0] }, 'skill', {}))
    return state
  }, result => result, { observeProjectilePaths: true })
}

describe('RED-227 bounded projectile preview recording', () => {
  it('records only indexed facts consumed before a piece stop', () => {
    const state = makeState({ width: 6, height: 2, pieces: [
      makePiece({ instanceId: 'source', x: 0, y: 0 }),
      makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0 }),
    ]})

    runObserved(state, flow => {
      const facts = flow.query.path({ x: 0, y: 0 }, { x: 1, y: 0 }, { excludePieceId: 'source' })
      expect(Array.isArray(facts)).toBe(true)
      for (let index = 0; index < facts.length; index += 1) {
        if (facts[index].type === 'piece') break
      }
      expect(facts.find(fact => fact.type === 'piece')?.type).toBe('piece')
    })

    expect(recordedProjectilePaths(state)).toMatchObject([{
      origin: { x: 0, y: 0 },
      direction: { x: 1, y: 0 },
      facts: [
        { type: 'cell', x: 1, y: 0 },
        { type: 'terrain', x: 1, y: 0 },
        { type: 'cell', x: 2, y: 0 },
        { type: 'piece', x: 2, y: 0 },
      ],
    }])
  })

  it('preserves cover occupant-before-terrain ordering for for-of consumers', () => {
    const state = makeState({ width: 5, height: 1, pieces: [
      makePiece({ instanceId: 'source', x: 0, y: 0 }),
      makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0 }),
    ]})
    const cover = state.map.tiles.find(tile => tile.x === 1 && tile.y === 0)!
    cover.props = { ...cover.props, type: 'cover', walkable: true }

    runObserved(state, flow => {
      const facts = flow.query.path({ x: 0, y: 0 }, { x: 1, y: 0 }, { excludePieceId: 'source' })
      for (const fact of facts) {
        if (fact.type === 'piece') break
      }
    })

    expect(recordedProjectilePaths(state)?.[0].facts.map(fact => fact.type)).toEqual(['cell', 'piece'])
  })

  it('keeps multiple origins separate and does not duplicate repeated reads', () => {
    const state = makeState({ width: 6, height: 2, pieces: [
      makePiece({ instanceId: 'source-a', x: 0, y: 0 }),
      makePiece({ instanceId: 'source-b', x: 0, y: 1 }),
    ]})

    runObserved(state, flow => {
      const first = flow.query.path({ x: 0, y: 0 }, { x: 1, y: 0 })
      void first[0]
      void first[0]
      const second = flow.query.path({ x: 0, y: 1 }, { x: 1, y: 0 })
      for (const fact of second) {
        if (fact.type === 'cell') break
      }
    })

    expect(recordedProjectilePaths(state)).toHaveLength(2)
    expect(recordedProjectilePaths(state)?.map(path => path.origin)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 1 }])
    expect(recordedProjectilePaths(state)?.[0].facts).toHaveLength(1)
    expect(recordedProjectilePaths(state)?.[1].facts).toHaveLength(1)
  })

  it('does not create a path event when a queried array is never consumed', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'source', x: 0, y: 0 })] })

    runObserved(state, flow => {
      const facts = flow.query.path({ x: 0, y: 0 }, { x: 1, y: 0 })
      expect(facts.length).toBeGreaterThan(0)
    })

    expect(recordedProjectilePaths(state)).toEqual([])
  })

  it('ignores out-of-range numeric reads and never records an undefined fact', () => {
    const state = makeState({ width: 3, height: 1, pieces: [makePiece({ instanceId: 'source', x: 0, y: 0 })] })

    runObserved(state, flow => {
      const facts = flow.query.path({ x: 0, y: 0 }, { x: 1, y: 0 }, { maxDistance: 1 })
      void facts[0]
      void facts[1]
      expect(facts[2]).toBeUndefined()
      expect(facts[99]).toBeUndefined()
    })

    expect(recordedProjectilePaths(state)?.[0].facts).toMatchObject([{ type: 'cell', x: 1, y: 0 }, { type: 'terrain', x: 1, y: 0 }])
    expect(recordedProjectilePaths(state)?.[0].facts).toHaveLength(2)
  })

  it('does not let a stale query proxy append to the completed weak recording', () => {
    const state = makeState({ width: 5, height: 1, pieces: [makePiece({ instanceId: 'source', x: 0, y: 0 })] })
    let stale: ReturnType<ReturnType<typeof createFlowRuntime>['query']['path']> | undefined

    recordBattlePresentation(state, () => {
      const flow = createFlowRuntime(state, { piece: state.pieces[0] }, 'skill', {})
      stale = flow.query.path({ x: 0, y: 0 }, { x: 1, y: 0 })
      void stale![0]
      return state
    }, result => result, { observeProjectilePaths: true })

    const before = recordedProjectilePaths(state)
    void stale![1]
    void stale![2]
    expect(recordedProjectilePaths(state)).toEqual(before)
  })

  it('snapshots the whitelisted tile and piece facts for independent consumers', () => {
    const state = makeState({ width: 4, height: 1, pieces: [
      makePiece({ instanceId: 'source', x: 0, y: 0 }),
      makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0 }),
    ]})

    runObserved(state, flow => {
      const facts = flow.query.path({ x: 0, y: 0 }, { x: 1, y: 0 })
      void facts[0]
      void facts[1]
    })
    state.map.tiles.find(tile => tile.x === 1 && tile.y === 0)!.props!.type = 'wall'
    state.pieces[1].currentHp = 0

    const first = recordedProjectilePaths(state)!
    expect(first[0].facts).toMatchObject([
      { type: 'cell', tile: { props: { type: 'floor' } } },
      { type: 'piece', piece: { instanceId: 'target', currentHp: 100 } },
    ])
    if (first[0].facts[0].type === 'cell') first[0].facts[0].tile.props!.type = 'mutated-by-consumer'
    expect(recordedProjectilePaths(state)?.[0].facts[0]).toMatchObject({ type: 'cell', tile: { props: { type: 'floor' } } })
  })

  it('rolls back observed paths together with the existing presentation scope', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'source', x: 0, y: 0 })] })

    recordBattlePresentation(state, () => {
      const flow = createFlowRuntime(state, { piece: state.pieces[0] }, 'skill', {})
      const first = flow.query.path({ x: 0, y: 0 }, { x: 1, y: 0 })
      void first[0]
      const restore = presentationRecordingRollback()
      const speculative = flow.query.path({ x: 0, y: 0 }, { x: 0, y: 1 })
      void speculative[0]
      restore()
      return state
    }, result => result, { observeProjectilePaths: true })

    expect(recordedProjectilePaths(state)?.map(path => path.origin)).toEqual([{ x: 0, y: 0 }])
    expect(recordedProjectilePaths(state)?.[0].direction).toEqual({ x: 1, y: 0 })
  })

  it('leaves recording disabled by default and preserves battle state', () => {
    const state = makeState({ pieces: [
      makePiece({ instanceId: 'source', x: 0, y: 0 }),
      makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0, currentHp: 17 }),
    ]})
    const before = JSON.stringify(state)

    recordBattlePresentation(state, () => {
      const flow = createFlowRuntime(state, { piece: state.pieces[0] }, 'skill', {})
      const facts = flow.query.path({ x: 0, y: 0 }, { x: 1, y: 0 })
      void facts[0]
      return state
    }, result => result)

    expect(recordedProjectilePaths(state)).toBeUndefined()
    expect(JSON.stringify(state)).toBe(before)
    expect(state.pieces[1].currentHp).toBe(17)
    expect(state.players[0].actionPoints).toBe(2)
  })
})
