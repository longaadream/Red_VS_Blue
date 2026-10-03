/* eslint-disable @typescript-eslint/no-explicit-any -- Browser input adapter is exercised with a small VM DOM. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

type Handler = (event: any) => void
type PointerCaptureTarget = Target & {
  setPointerCapture: ReturnType<typeof vi.fn>
  releasePointerCapture: ReturnType<typeof vi.fn>
}

class Target {
  private listeners = new Map<string, Handler[]>()

  addEventListener(type: string, handler: Handler) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), handler])
  }

  removeEventListener(type: string, handler: Handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(candidate => candidate !== handler))
  }

  dispatch(type: string, init: Record<string, unknown> = {}) {
    const event: any = {
      type,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      ...init,
    }
    for (const handler of [...(this.listeners.get(type) || [])]) handler(event)
    return event
  }
}

class Button extends Target {
  dataset: Record<string, string> = { skillId: 'skill-a' }
  disabled = false
  classes = new Set(['piece-context-skill'])
  attrs = new Map<string, string>()

  closest(selector: string) {
    const matches = selector.includes('.piece-context-skill') && this.classes.has('piece-context-skill')
      || selector.includes('.character-cast') && this.classes.has('character-cast')
    return matches ? this : null
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null
  }
}

function harness(overrides: Record<string, unknown> = {}) {
  const documentElement = new Target() as PointerCaptureTarget
  const view = new Target()
  const documentRoot = new Target() as Target & { documentElement: PointerCaptureTarget; defaultView: Target }
  documentRoot.documentElement = documentElement
  documentRoot.defaultView = view
  documentElement.setPointerCapture = vi.fn()
  documentElement.releasePointerCapture = vi.fn()
  const button = new Button()
  const events: Array<string> = []
  const resolveContext = { skillId: 'skill-a', pieceId: 'piece-a' }
  const callbacks = {
    resolve: vi.fn(() => resolveContext),
    arm: vi.fn(() => true),
    cellAt: vi.fn((x: number, y: number) => ({ x: Math.round(x / 10), y: Math.round(y / 10) })),
    preview: vi.fn((cell: unknown) => { events.push('preview:' + JSON.stringify(cell)) }),
    clear: vi.fn(() => { events.push('clear') }),
    release: vi.fn((cell: unknown) => { events.push('release:' + JSON.stringify(cell)) }),
    onError: vi.fn(),
    ...overrides,
  }
  const window: Record<string, unknown> = {}
  const context = createContext({ window, globalThis: window, console, setTimeout, clearTimeout })
  const source = readFileSync(resolve('data/pages/js/battle-ui/battle-skill-drag.js'), 'utf8')
  new Script(source, { filename: 'battle-skill-drag.js' }).runInContext(context)
  const controller = (window.BattleSkillDrag as { create(options: unknown): unknown }).create({ root: documentRoot, ...callbacks }) as { dispose(): void }
  const pointer = (type: string, pointerId: number, x: number, y: number, target: unknown = button, extra: Record<string, unknown> = {}) =>
    documentRoot.dispatch(type, { pointerId, pointerType: 'mouse', button: 0, clientX: x, clientY: y, target, ...extra })
  return { documentRoot, documentElement, view, button, callbacks, events, controller, pointer }
}

describe('battle skill drag input adapter', () => {
  it('arms mouse drag at eight pixels, captures on documentElement, previews, releases, and suppresses click', () => {
    const h = harness()
    h.pointer('pointerdown', 1, 10, 10)
    h.pointer('pointermove', 1, 17, 10)
    expect(h.callbacks.arm).not.toHaveBeenCalled()
    const move = h.pointer('pointermove', 1, 18, 10)
    expect(h.callbacks.arm).toHaveBeenCalledOnce()
    expect(h.callbacks.arm).toHaveBeenCalledWith({ skillId: 'skill-a', pieceId: 'piece-a' })
    expect(h.documentElement.setPointerCapture).toHaveBeenCalledWith(1)
    expect(move.preventDefault).toHaveBeenCalled()
    h.pointer('pointermove', 1, 30, 20)
    const up = h.pointer('pointerup', 1, 30, 20)
    expect(h.events.at(-2)).toBe('clear')
    expect(h.events.at(-1)).toBe('release:{"x":3,"y":2}')
    expect(h.callbacks.clear).toHaveBeenCalledOnce()
    expect(h.callbacks.release).toHaveBeenCalledWith({ x: 3, y: 2 })
    expect(up.preventDefault).toHaveBeenCalled()

    const click = h.documentRoot.dispatch('click', { target: h.button })
    expect(click.preventDefault).toHaveBeenCalled()
    expect(click.stopImmediatePropagation).toHaveBeenCalled()
  })

  it('supports touch pointers and sends an inside invalid cell to the existing release path', () => {
    const h = harness({ cellAt: vi.fn(() => ({ x: 4, y: 5, legal: false })) })
    h.pointer('pointerdown', 7, 1, 1, h.button, { pointerType: 'touch', button: undefined })
    h.pointer('pointermove', 7, 9, 1, h.button, { pointerType: 'touch', button: undefined })
    h.pointer('pointerup', 7, 9, 1, h.button, { pointerType: 'touch', button: undefined })

    expect(h.callbacks.arm).toHaveBeenCalledOnce()
    expect(h.callbacks.release).toHaveBeenCalledWith({ x: 4, y: 5, legal: false })
  })

  it('keeps the original click when arm declines and does not release an outside pointerup', () => {
    const h = harness({
      arm: vi.fn(() => false),
      cellAt: vi.fn(() => null),
    })
    h.pointer('pointerdown', 2, 0, 0)
    h.pointer('pointermove', 2, 8, 0)
    const up = h.pointer('pointerup', 2, 8, 0)
    const click = h.documentRoot.dispatch('click', { target: h.button })

    expect(h.callbacks.arm).toHaveBeenCalledOnce()
    expect(h.documentElement.setPointerCapture).not.toHaveBeenCalled()
    expect(h.callbacks.preview).not.toHaveBeenCalled()
    expect(h.callbacks.clear).not.toHaveBeenCalled()
    expect(h.callbacks.release).not.toHaveBeenCalled()
    expect(up.preventDefault).not.toHaveBeenCalled()
    expect(click.preventDefault).not.toHaveBeenCalled()
  })

  it.each(['pointercancel', 'blur', 'escape'])('cancels %s after arming without committing a release', type => {
    const h = harness()
    h.pointer('pointerdown', 3, 0, 0)
    h.pointer('pointermove', 3, 8, 0)
    if (type === 'pointercancel') h.pointer('pointercancel', 3, 8, 0)
    else if (type === 'blur') h.view.dispatch('blur')
    else h.documentRoot.dispatch('keydown', { key: 'Escape' })

    expect(h.callbacks.clear).toHaveBeenCalledOnce()
    expect(h.callbacks.release).not.toHaveBeenCalled()
  })

  it('ignores replaced-button and document capture loss, but cancels real root capture loss', () => {
    const h = harness()
    h.pointer('pointerdown', 8, 0, 0)
    h.pointer('pointermove', 8, 8, 0)
    h.documentRoot.dispatch('lostpointercapture', { pointerId: 8, target: h.button })
    h.documentRoot.dispatch('lostpointercapture', { pointerId: 8, target: h.documentRoot })
    h.pointer('pointermove', 8, 20, 0)
    h.pointer('pointerup', 8, 20, 0)

    expect(h.callbacks.clear).toHaveBeenCalledOnce()
    expect(h.callbacks.release).toHaveBeenCalledOnce()

    const cancelled = harness()
    cancelled.pointer('pointerdown', 9, 0, 0)
    cancelled.pointer('pointermove', 9, 8, 0)
    cancelled.documentRoot.dispatch('lostpointercapture', {
      pointerId: 9,
      target: cancelled.documentElement,
    })
    cancelled.pointer('pointerup', 9, 20, 0)

    expect(cancelled.callbacks.clear).toHaveBeenCalledOnce()
    expect(cancelled.callbacks.release).not.toHaveBeenCalled()
  })

  it('cancels the first drag when a second pointer arrives and waits for both pointers to leave', () => {
    const h = harness()
    h.pointer('pointerdown', 10, 0, 0)
    h.pointer('pointermove', 10, 8, 0)
    h.pointer('pointerdown', 11, 0, 0, h.button, { pointerType: 'touch', button: undefined })
    h.pointer('pointermove', 10, 20, 0)
    h.pointer('pointerup', 10, 20, 0)
    h.pointer('pointerup', 11, 0, 0, h.button, { pointerType: 'touch', button: undefined })

    expect(h.callbacks.clear).toHaveBeenCalledOnce()
    expect(h.callbacks.release).not.toHaveBeenCalled()
  })

  it('does not start from disabled skill buttons or unrelated targets', () => {
    const h = harness()
    h.button.disabled = true
    h.pointer('pointerdown', 1, 0, 0)
    h.pointer('pointermove', 1, 20, 0)
    h.pointer('pointerup', 1, 20, 0)
    const other = new Button()
    other.classes.clear()
    h.pointer('pointerdown', 2, 0, 0, other)
    h.pointer('pointermove', 2, 20, 0, other)

    expect(h.callbacks.resolve).not.toHaveBeenCalled()
    expect(h.callbacks.arm).not.toHaveBeenCalled()
  })

  it('reports resolver and callback errors without executing a skill itself', () => {
    const error = new Error('drag callback failed')
    const h = harness({ resolve: vi.fn(() => { throw error }) })
    h.pointer('pointerdown', 1, 0, 0)
    expect(h.callbacks.onError).toHaveBeenCalledWith(error)
    expect(h.callbacks.arm).not.toHaveBeenCalled()
  })

  it('leaves a non-drag pointer sequence available to the original click handler', () => {
    const h = harness()
    h.pointer('pointerdown', 4, 10, 10)
    h.pointer('pointerup', 4, 10, 10)
    const click = h.documentRoot.dispatch('click', { target: h.button })

    expect(h.callbacks.arm).not.toHaveBeenCalled()
    expect(h.callbacks.release).not.toHaveBeenCalled()
    expect(click.preventDefault).not.toHaveBeenCalled()
  })
})
