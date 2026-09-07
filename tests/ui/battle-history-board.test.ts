import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'
import { describe, it, expect, vi } from 'vitest'

type HistoryOptions = { setHistoricalBoard(id: string | null, events?: unknown[]): ReturnType<typeof model> | null }
type Presentation = { mount(options: unknown): void; update(model: unknown): void; animateAction(...args: unknown[]): void; captureHistory(events: unknown[], model: unknown): void; getModel(): ReturnType<typeof model>; dispose(): void }

function harness() {
  const window = {} as { BattlePresentation: { create(options: unknown): Presentation } }
  new Script(readFileSync(resolve('data/pages/js/battle-ui/battle-presentation.js'), 'utf8')).runInContext(createContext({ window, globalThis: window, console }))
  const listeners = new Map<string, (event: unknown) => void>()
  const doc = { body: { classList: { toggle: vi.fn() } }, addEventListener: (t: string, f: (event: unknown) => void) => listeners.set(t, f), removeEventListener: (t: string) => listeners.delete(t) }
  const renderer = { init: vi.fn(), update: vi.fn(), showHistoricalBoard: vi.fn(), setHistoryHighlight: vi.fn(), animateAction: vi.fn(), dispose: vi.fn() }
  let historyOptions: HistoryOptions
  const ui = window.BattlePresentation.create({ renderer, domUi: { update: vi.fn(), dispose: vi.fn() }, historyUi: { mount: (o: HistoryOptions) => { historyOptions = o }, update: vi.fn(), dispose: vi.fn() } })
  ui.mount({ boardContainer: { ownerDocument: doc } })
  return { ui, renderer, listeners, get options() { return historyOptions } }
}
function model(x = 1, events: unknown[] = []) {
  return { board: { id: 'map', width: 8, height: 8, tiles: [{ x: 1, y: 1, type: 'floor' }] }, pieces: [{ id: 'victim', visible: true, x, y: 1 }], effects: [], viewer: { id: 'red' }, turn: { number: 2 }, presentationEvents: events }
}
const event = { eventId: 'a', rootEventId: 'a', parentEventId: null, kind: 'forceMove', targetPieceIds: ['victim'], result: { fromX: 1, fromY: 1, toX: 4, toY: 1 } }

describe('historical main board', () => {

  it('keeps viewer identity when a normal action supplies its before snapshot through animation', () => {
    const h = harness(), before = model(1), after = model(4, [event])
    h.ui.update(before)
    h.ui.animateAction({ type: 'move' }, before, after)
    h.ui.update(after)
    expect(h.options.setHistoricalBoard('a', [event])?.pieces[0].x).toBe(1)
    h.ui.dispose()
  })


  it('does not rebuild or re-enter for missing snapshots, including a viewport callback during return', () => {
    const h = harness()
    h.ui.update(model())
    h.renderer.showHistoricalBoard.mockImplementation(() => h.options.setHistoricalBoard('missing', []))
    expect(() => h.options.setHistoricalBoard('missing', [])).not.toThrow()
    expect(h.renderer.showHistoricalBoard).not.toHaveBeenCalled()
    h.ui.update(model(4, [event]))
    h.renderer.showHistoricalBoard.mockImplementation(() => {})
    h.options.setHistoricalBoard('a', [event])
    h.renderer.showHistoricalBoard.mockClear()
    h.renderer.showHistoricalBoard.mockImplementation(() => h.options.setHistoricalBoard('missing', []))
    expect(() => h.options.setHistoricalBoard('missing', [])).not.toThrow()
    expect(h.renderer.showHistoricalBoard).toHaveBeenCalledOnce()
    h.ui.dispose()
  })
  it('keeps separately captured viewer histories across automatic training turn changes', () => {
    const h = harness()
    h.ui.update(model())
    h.ui.captureHistory([event], model(1))
    h.ui.captureHistory([event], { ...model(2), viewer: { id: 'blue' } })
    h.ui.update(model(4, [event]))
    h.ui.update({ ...model(4, [event]), viewer: { id: 'blue' } })
    expect(h.options.setHistoricalBoard('a', [event])?.pieces[0].x).toBe(2)
    h.options.setHistoricalBoard(null)
    h.ui.update(model(5, [event]))
    expect(h.options.setHistoricalBoard('a', [event])?.pieces[0].x).toBe(1)
    h.ui.dispose()
  })


  it('finishes successful training placement before rendering, preserving failed placement for retry', async () => {
    const source = readFileSync(resolve('data/pages/battle.html'), 'utf8')
    const start = source.indexOf('async function sendPatch(')
    const end = source.indexOf('// ── Training: switch perspective', start)
    for (const failed of [false, true]) {
      const old = { pieces: [{ id: 'old' }] }, next = { pieces: [{ id: 'old' }, { id: 'added' }] }
      const context = { togglePlaceMode: () => {}, sendPatch: async (body: unknown) => { void body; return false }, G: old, placingMode: true, trainingApiFetch: async () => { if (failed) throw Error('rejected'); return next },
        reconcileBattleInteractionState: () => '', setStatusMsg: () => {}, addLog: () => {}, render: vi.fn() }
      context.togglePlaceMode = () => { context.placingMode = !context.placingMode }
      const vm = createContext(context)
      new Script(source.slice(start, end)).runInContext(vm)
      const result = await context.sendPatch({ type: 'addPiece' })
      expect(result).toBe(!failed)
      expect(context.placingMode).toBe(failed)
      expect(context.G).toBe(failed ? old : next)
      expect(context.render).toHaveBeenCalledTimes(failed ? 0 : 1)
    }
  })
  it('keeps old snapshots immutable when training adds pieces, and captures new actions with the added piece', () => {
    const h = harness()
    h.ui.update(model())
    h.ui.update(model(4, [event]))
    const placed = model(4, [event])
    placed.pieces.push({ id: 'new-piece', visible: true, x: 6, y: 6 })
    h.ui.update(placed)
    expect(h.options.setHistoricalBoard('a', [event])?.pieces).toHaveLength(1)
    h.options.setHistoricalBoard(null)
    expect(h.renderer.showHistoricalBoard.mock.lastCall?.[0].pieces).toHaveLength(2)
    const next = JSON.parse(JSON.stringify(placed))
    const nextEvent = { ...event, eventId: 'next', rootEventId: 'next' }
    next.presentationEvents.push(nextEvent)
    next.pieces[0].x = 5
    h.ui.update(next)
    const history = h.options.setHistoricalBoard('next', [nextEvent])
    expect(history?.pieces).toHaveLength(2)
    expect(history?.pieces[0].x).toBe(4)
    h.ui.dispose()
  })

  it('restores the saved whole board, blocks commands, and returns to the latest received state', () => {
    const h = harness(), before = model()
    h.ui.update(before)
    h.ui.update(model(4, [event]))
    before.pieces[0].x = 7
    expect(h.options.setHistoricalBoard('a', [event])?.pieces[0].x).toBe(1)
    expect(h.renderer.showHistoricalBoard.mock.lastCall?.[0]).toMatchObject({ pieces: [{ x: 1 }], historyPreview: true, legal: { moveCells: [] } })
    expect(h.renderer.setHistoryHighlight.mock.lastCall?.[0]).toContainEqual({ x: 4, y: 1, role: 'target', fromX: 1, fromY: 1 })
    const click = { type: 'click', target: { closest: () => null }, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
    h.listeners.get('click')!(click)
    expect(click.preventDefault).toHaveBeenCalledOnce()
    const calls = h.renderer.update.mock.calls.length
    h.ui.update(model(6, [event]))
    expect(h.renderer.update.mock.calls).toHaveLength(calls)
    h.options.setHistoricalBoard(null)
    expect(h.renderer.showHistoricalBoard.mock.lastCall?.[0].pieces[0].x).toBe(6)
    expect(h.ui.getModel().pieces[0].x).toBe(6)
  })
  it('does not invent initial/catch-up history or carry snapshots across viewers', () => {
    const h = harness()
    h.ui.update(model(4, [event]))
    expect(h.options.setHistoricalBoard('a', [event])).toBeNull()
    h.ui.update(model(5, [{ ...event, eventId: 'b', rootEventId: 'b' }, { ...event, eventId: 'c', rootEventId: 'c' }]))
    expect(h.options.setHistoricalBoard('b', [])).toBeNull()
    h.ui.update(model(6, [{ ...event, eventId: 'd', rootEventId: 'd' }]))
    h.ui.update({ ...model(2, [{ ...event, rootEventId: 'enemy-private', eventId: 'enemy-private' }]), viewer: { id: 'blue' } })
    expect(h.options.setHistoricalBoard('enemy-private', [])).toBeNull()
    expect(h.options.setHistoricalBoard('d', [])).toBeNull()
    h.ui.dispose()
    expect(h.listeners.size).toBe(0)
  })
})
