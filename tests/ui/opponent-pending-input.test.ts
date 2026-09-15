import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8')
const script = page.slice(page.indexOf('    function waitingForOtherPending()'), page.indexOf('    function showMsg('))

describe('opponent pending input lock', () => {
  it.each(['pendingTargetSelection', 'pendingOptionSelection'])('blocks input during %s and restores it when resolved', key => {
    const state: Record<string, unknown> = { [key]: { playerId: 'other' } }
    const status = { textContent: '' }
    const listeners = new Map<string, (event: unknown) => void>()
    const context = {
      G: state, clientOwns: (id: string) => id === 'me',
      document: { addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler), getElementById: () => status },
    }
    runInNewContext(script, context)
    const event = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
    listeners.get('click')!(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(status.textContent).toBe('等待对方操作')
    const bookEvent = { target: { closest: (selector: string) => selector === '#rulebook, #rulebookButton' ? {} : null }, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
    for (const type of ['click', 'keydown', 'wheel']) listeners.get(type)!(bookEvent)
    expect(bookEvent.preventDefault).not.toHaveBeenCalled()
    runInNewContext("setStatusMsg('等待权威响应')", context)
    expect(status.textContent).toBe('等待对方操作')
    state[key] = null
    event.preventDefault.mockClear()
    listeners.get('click')!(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    state[key] = { playerId: 'me' }
    listeners.get('keydown')!(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
