/* eslint-disable @typescript-eslint/no-explicit-any -- Executes untyped browser adapters in a VM, matching the existing UI test harness. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')

function loadModule(relativePath: string, exportName: string, window: Record<string, unknown> = {}) {
  const context = createContext({ window, globalThis: window, console })
  new Script(readFileSync(resolve(pagesDir, relativePath), 'utf8'), { filename: relativePath }).runInContext(context)
  return window[exportName] as Record<string, any>
}

describe('RED-240 ordered normal-move paths', () => {
  it('keeps route order and rejects malformed coordinates in the view model', () => {
    const viewModel = loadModule('js/battle-ui/battle-view-model.js', 'BattleViewModel')

    expect(viewModel.normalizePathCells([
      { x: 2, y: 1 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: null, y: 4 }, '4,',
    ])).toEqual([
      { x: 2, y: 1 }, { x: 2, y: 0 }, { x: 1, y: 0 },
      { x: 2, y: 1 },
    ])
  })

  it('asks the engine for both the automatic route and exact-path rejection', () => {
    const legal = loadModule('js/battle-ui/battle-legal-actions.js', 'BattleLegalActions')
    const engine = {
      safeCloneBattleState: vi.fn((state: any) => JSON.parse(JSON.stringify(state))),
      getNormalMovePath: vi.fn((_state: any, piece: any, target: any, waypoints: any[]) => {
        expect(piece.instanceId).toBe('piece')
        expect(target).toEqual({ x: 3, y: 2 })
        expect(waypoints).toEqual([{ x: 2, y: 0 }])
        return [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }]
      }),
      getNormalMoveRejection: vi.fn((_state: any, _piece: any, target: any, path: any[]) => {
        expect(target).toEqual({ x: 3, y: 2 })
        expect(path).toEqual([{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }])
        return null
      }),
    }
    const snapshot = { pieces: [{ instanceId: 'piece', x: 1, y: 0, currentHp: 10 }] }
    const path = legal.getNormalMovePath({ snapshot, engine, pieceId: 'piece', target: { x: 3, y: 2 }, waypoints: [{ x: 2, y: 0 }] })

    expect(path).toEqual([{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }])
    expect(legal.getNormalMoveRejection({ snapshot, engine, pieceId: 'piece', target: { x: 3, y: 2 }, path })).toBeNull()
    expect(engine.safeCloneBattleState).not.toHaveBeenCalled()
    expect(engine.getNormalMovePath.mock.calls[0][0]).toBe(snapshot)
    expect(snapshot).toEqual({ pieces: [{ instanceId: 'piece', x: 1, y: 0, currentHp: 10 }] })
  })
})
