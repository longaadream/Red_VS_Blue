import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Script, createContext } from 'node:vm'

describe('pending presentation contract', () => {
  it('flushes presentation before local target and option selectors', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'data/pages/battle.html'), 'utf8')
    expect(page).toContain('function flushPresentationBeforePendingSelection()')
    expect(page).toMatch(/function enterActionTargetMode[\s\S]*?flushPresentationBeforePendingSelection\(\)/)
    expect(page).toMatch(/function showOptionPicker[\s\S]*?flushPresentationBeforePendingSelection\(\)/)
    expect(page).toMatch(/function syncAuthoritativePendingPresentation\(\)[\s\S]*?flushPresentationBeforePendingSelection\(\)/)
  })
})


type Model = {
  board: object; pieces: Array<{ id: string; x: number; y: number }>; effects: unknown[];
  viewer: { id: string }; turn: { isViewerTurn: boolean }; presentationEvents: unknown[];
  interaction?: { pendingResponse: { selectionId: string; isForViewer: boolean; isOffTurn: boolean } };
}
type Queue = { update(model: Model): void; settleAll(): void; dispose(): void; getDiagnostics(): { activeRootId: string | null; timerCount: number } }
type Presentation = { mount(options: object): void; update(model: Model): void; settleForSelection(): void; dispose(): void }
type MountOptions = { onPlaybackPhase: (...args: unknown[]) => void; onPlaybackIdle: () => void }

// Exercise the real presentation queue and its renderer lifecycle together.
describe('pending selection live board', () => {
  it.each([true, false])('settles newly delivered animation only for the choosing viewer=%s', (isForViewer) => {
    const win = { setTimeout, clearTimeout } as { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; BattleActionVignette: { createQueue(options: object): Queue }; BattlePresentation: { create(options: object): Presentation } }
    const context = createContext({ window: win, globalThis: win, console })
    for (const file of ['battle-action-vignette.js', 'battle-presentation.js']) {
      new Script(fs.readFileSync(path.join(process.cwd(), 'data/pages/js/battle-ui', file), 'utf8')).runInContext(context)
    }
    let queue!: Queue
    const vignette = {
      sequencesBoard: true,
      mount(options: MountOptions) { queue = win.BattleActionVignette.createQueue({ onPhase: options.onPlaybackPhase, onIdle: options.onPlaybackIdle }) },
      update(model: Model) { queue.update(model) },
      settleAll() { queue.settleAll() },
      getDiagnostics() { return queue.getDiagnostics() },
      dispose() { queue.dispose() },
    }
    const renderer = { init: vi.fn(), update: vi.fn(), settlePresentation: vi.fn(), animateAction: vi.fn(), dispose: vi.fn() }
    let latest: Model
    const idle = vi.fn(() => presentation.update(latest))
    const presentation = win.BattlePresentation.create({ renderer, vignetteUi: vignette, domUi: { update() {}, dispose() {} }, onPlaybackIdle: idle })
    presentation.mount({})
    const initial = { board: {}, pieces: [{ id: 'p', x: 0, y: 0 }], effects: [], viewer: { id: 'red' }, turn: { isViewerTurn: false }, presentationEvents: [] }
    latest = initial
    presentation.update(initial)
    idle.mockClear()
    latest = { ...initial, pieces: [{ id: 'p', x: 4, y: 0 }], interaction: { pendingResponse: { selectionId: 'one', isForViewer, isOffTurn: true } }, presentationEvents: [{ eventId: 'a:0', rootEventId: 'a:0', sequence: 0, kind: 'move', sourcePieceId: 'p', result: { toX: 4, toY: 0 } }] }
    try {
      presentation.update(latest)
      if (isForViewer) {
        expect(queue.getDiagnostics().activeRootId).toBeNull()
        expect(renderer.update.mock.lastCall?.[0].pieces[0].x).toBe(4)
        expect(idle).not.toHaveBeenCalled()
        latest = { ...latest, pieces: [{ id: 'p', x: 5, y: 0 }], interaction: { pendingResponse: { selectionId: 'two', isForViewer, isOffTurn: true } }, presentationEvents: [{ eventId: 'b:0', rootEventId: 'b:0', sequence: 0, kind: 'move', sourcePieceId: 'p', result: { toX: 5, toY: 0 } }] }
        presentation.update(latest)
        presentation.settleForSelection()
        expect(renderer.settlePresentation.mock.lastCall?.[0].pieces[0].x).toBe(5)
        expect(queue.getDiagnostics().timerCount).toBe(0)
        expect(idle).not.toHaveBeenCalled()
      } else {
        expect(queue.getDiagnostics().activeRootId).toBe('a:0')
        expect(queue.getDiagnostics().timerCount).toBeGreaterThan(0)
      }
    } finally { presentation.dispose() }
  })
})
