/* eslint-disable @typescript-eslint/no-explicit-any -- The browser-only social widget runs in a small DOM VM. */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: any) => void

class FakeElement {
  readonly tagName: string
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Listener[]>()
  readonly attributes = new Map<string, string>()
  readonly classList = {
    add: (name: string) => this.classNames.add(name),
    remove: (name: string) => this.classNames.delete(name),
    contains: (name: string) => this.classNames.has(name),
  }
  readonly classNames = new Set<string>()
  parentNode: FakeElement | null = null
  hidden = false
  disabled = false
  className = ''
  value = ''
  type = ''
  textContent = ''
  scrollTop = 0
  private _innerHTML = ''
  private readonly namedChildren = new Map<string, FakeElement>()

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  get innerHTML() { return this._innerHTML }

  set innerHTML(value: string) {
    this._innerHTML = String(value)
    if (this.tagName !== 'ASIDE') return

    const toggle = new FakeElement('button')
    toggle.textContent = '聊天'
    const panel = new FakeElement('section')
    panel.hidden = true
    const notes = new FakeElement('ol')
    const choices = new FakeElement('div')
    const form = new FakeElement('form')
    const input = new FakeElement('textarea')
    const submit = new FakeElement('button')
    const status = new FakeElement('p')
    submit.type = 'submit'
    form.appendChild(input)
    form.appendChild(submit)
    panel.appendChild(notes)
    panel.appendChild(choices)
    panel.appendChild(form)
    panel.appendChild(status)
    this.appendChild(toggle)
    this.appendChild(panel)
    this.namedChildren.set('.social-toggle', toggle)
    this.namedChildren.set('section', panel)
    this.namedChildren.set('.social-panel', panel)
    this.namedChildren.set('.social-notes', notes)
    this.namedChildren.set('ol', notes)
    this.namedChildren.set('.social-presets', choices)
    this.namedChildren.set('form', form)
    this.namedChildren.set('textarea', input)
    this.namedChildren.set('.social-status', status)
    this.namedChildren.set('form button', submit)
  }

  get firstElementChild() { return this.children[0] || null }

  append(...items: FakeElement[]) {
    items.forEach(item => this.appendChild(item))
  }

  appendChild(child: FakeElement) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    child.className.split(/\s+/).filter(Boolean).forEach(name => this.namedChildren.set('.' + name, child))
    return child
  }

  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() { this.parentNode?.removeChild(this) }

  replaceChildren(...items: FakeElement[]) {
    this.children.splice(0).forEach(child => { child.parentNode = null })
    items.forEach(item => this.appendChild(item))
  }

  querySelector(selector: string): FakeElement | null {
    const named = this.namedChildren.get(selector)
    if (named) return named
    if (selector === 'button') {
      const direct = this.children.find(child => child.tagName === 'BUTTON')
      if (direct) return direct
      for (const child of this.children) {
        const nested: FakeElement | null = child.querySelector(selector)
        if (nested) return nested
      }
    }
    return null
  }

  querySelectorAll(selector: string) {
    if (selector === 'form button,.social-presets button') {
      const submit = this.namedChildren.get('form button')
      const choices = this.namedChildren.get('.social-presets')
      return [submit, ...(choices ? choices.children : [])].filter(Boolean)
    }
    return []
  }

  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)) }

  getAttribute(name: string) { return this.attributes.get(name) || null }

  focus() {}

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener])
  }

  dispatchEvent(type: string, event: any = {}) {
    this.listeners.get(type)?.forEach(listener => listener(event))
  }
}

type SocialApi = {
  mount(options: { send: (message: unknown) => boolean; spectating?: boolean; offline?: boolean; offlineNotice?: string }): {
    setConnected(value: boolean): void
    receive(message: any): void
    dispose(): void
  }
}

function loadSocial() {
  const body = new FakeElement('body')
  const document = {
    body,
    createElement: (tagName: string) => new FakeElement(tagName),
  }
  const windowObject: Record<string, unknown> = {}
  const context = createContext({
    window: windowObject,
    globalThis: windowObject,
    document,
    console,
    Date,
    Intl,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })
  new Script(readFileSync('data/pages/js/battle-social.js', 'utf8'), { filename: 'battle-social.js' }).runInContext(context)
  return { api: windowObject.BattleSocial as SocialApi, body }
}

function readyWidget(spectating = false) {
  const { api, body } = loadSocial()
  const send = vi.fn((message: unknown): boolean => { void message; return true })
  const widget = api.mount({ send, spectating })
  const root = body.children[0]
  const input = root.querySelector('textarea')!
  const status = root.querySelector('.social-status')!
  const choices = root.querySelector('.social-presets')!
  widget.setConnected(true)
  widget.receive({
    type: 'socialReady',
    supported: true,
    protocolVersion: 1,
    presetIds: ['hello'],
    stampIds: ['heart'],
  })
  return { widget, send, root, input, status, choices }
}

function enterEvent() {
  return {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RED-241 battle social widget', () => {
  it('does not submit Enter while IME composition is active, then submits after composition ends', () => {
    vi.useFakeTimers()
    const { widget, send, input } = readyWidget()
    input.value = '你好'

    input.dispatchEvent('compositionstart')
    const composingEnter = enterEvent()
    input.dispatchEvent('keydown', composingEnter)
    expect(send.mock.calls.filter(([message]) => (message as any).type === 'socialSend')).toHaveLength(0)
    expect(composingEnter.preventDefault).not.toHaveBeenCalled()

    input.dispatchEvent('compositionend')
    input.dispatchEvent('keydown', enterEvent())
    expect(send.mock.calls.filter(([message]) => (message as any).type === 'socialSend')).toHaveLength(1)
    widget.dispose()
  })

  it('renders remote names and text with textContent instead of interpreting markup', () => {
    vi.useFakeTimers()
    const { widget, root } = readyWidget()
    widget.receive({
      type: 'socialEvent',
      kind: 'text',
      displayName: '<img src=x onerror=bad()>',
      payload: '<script>bad()</script>',
    })

    const note = root.querySelector('.social-notes')!.children[0]
    expect(note.children[0].textContent).toBe('<img src=x onerror=bad()>')
    expect(note.children[1].textContent).toBe('<script>bad()</script>')
    expect(note.innerHTML).toBe('')
    widget.dispose()
  })

  it('starts a three-second cooldown only after a successful acknowledgement', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { widget, send, input, status } = readyWidget()
    input.value = 'first'
    input.dispatchEvent('keydown', enterEvent())
    const first = send.mock.calls.find(([message]) => (message as any).type === 'socialSend')?.[0] as any
    widget.receive({ type: 'socialAck', requestId: first.requestId, ok: true })
    expect(input.value).toBe('')

    input.value = 'too soon'
    input.dispatchEvent('keydown', enterEvent())
    expect(send.mock.calls.filter(([message]) => (message as any).type === 'socialSend')).toHaveLength(1)
    expect(status.textContent).toContain('稍等')

    vi.advanceTimersByTime(3000)
    input.dispatchEvent('keydown', enterEvent())
    expect(send.mock.calls.filter(([message]) => (message as any).type === 'socialSend')).toHaveLength(2)
    widget.dispose()
  })

  it('retains the draft when the server rejects a social message', () => {
    vi.useFakeTimers()
    const { widget, send, input, status } = readyWidget()
    input.value = 'keep this draft'
    input.dispatchEvent('keydown', enterEvent())
    const request = send.mock.calls.find(([message]) => (message as any).type === 'socialSend')?.[0] as any
    widget.receive({ type: 'socialAck', requestId: request.requestId, ok: false, code: 'SOCIAL_TEXT_INVALID' })

    expect(input.value).toBe('keep this draft')
    expect(status.textContent).toBe('便笺未发送，请检查内容或连接')
    widget.dispose()
  })

  it('clears pending requests on disconnect and never queues them for reconnect', () => {
    vi.useFakeTimers()
    const { widget, send, input } = readyWidget()
    input.value = 'do not queue'
    input.dispatchEvent('keydown', enterEvent())
    expect(send.mock.calls.filter(([message]) => (message as any).type === 'socialSend')).toHaveLength(1)

    widget.setConnected(false)
    send.mockClear()
    widget.setConnected(true)
    expect(send.mock.calls).toHaveLength(1)
    expect((send.mock.calls[0][0] as any).type).toBe('socialHello')
    expect(input.value).toBe('do not queue')
    widget.dispose()
  })

  it('keeps spectators read-only even after the server advertises social support', () => {
    vi.useFakeTimers()
    const { widget, send, input, choices, status } = readyWidget(true)
    expect(input.disabled).toBe(true)
    expect(choices.children).toHaveLength(2)

    input.value = 'spectator draft'
    input.dispatchEvent('keydown', enterEvent())
    choices.children[0].dispatchEvent('click')

    expect(send.mock.calls.filter(([message]) => (message as any).type === 'socialSend')).toHaveLength(0)
    expect(status.textContent).toBe('观战中：可以阅读便笺')
    widget.dispose()
  })

  it('shows a clear offline chat entry without sending or faking replies', () => {
    vi.useFakeTimers()
    const { api, body } = loadSocial()
    const send = vi.fn((message: unknown): boolean => { void message; return true })
    const widget = api.mount({ send, offline: true, offlineNotice: '练习模式：当前没有真人对手，聊天不可发送' })
    const root = body.children[0]
    const toggle = root.querySelector('.social-toggle')!
    const input = root.querySelector('textarea')!
    const status = root.querySelector('.social-status')!
    const notes = root.querySelector('.social-notes')!

    expect(toggle.textContent).toBe('聊天')
    expect(root.className).toContain('is-offline')
    expect(input.disabled).toBe(true)
    expect(status.textContent).toBe('练习模式：当前没有真人对手，聊天不可发送')

    widget.setConnected(true)
    input.value = '不会发送给真人'
    input.dispatchEvent('keydown', enterEvent())
    widget.receive({ type: 'socialEvent', messageId: 'fake-ai', kind: 'text', displayName: 'AI', payload: '伪造回复' })

    expect(send).not.toHaveBeenCalled()
    expect(notes.children).toHaveLength(0)
    expect(status.textContent).toBe('练习模式：当前没有真人对手，聊天不可发送')
    widget.dispose()
  })

  it('deduplicates repeated remote events by messageId while updating the arrival toast safely', () => {
    vi.useFakeTimers()
    const { widget, root } = readyWidget()
    const event = {
      type: 'socialEvent',
      messageId: 'server-message-1',
      kind: 'text',
      displayName: 'Alice',
      payload: '先到',
    }

    widget.receive(event)
    widget.receive(event)

    const notes = root.querySelector('.social-notes')!
    const toast = root.querySelector('.social-arrival-note')!
    expect(notes.children).toHaveLength(1)
    expect(toast.textContent).toBe('Alice：先到')
    expect(toast.hidden).toBe(false)
    widget.dispose()
  })

  it('closes the open panel on Escape and leaves composition Escape untouched', () => {
    vi.useFakeTimers()
    const { widget, root } = readyWidget()
    const toggle = root.querySelector('.social-toggle')!
    const panel = root.querySelector('section')!

    toggle.dispatchEvent('click')
    expect(panel.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    root.dispatchEvent('keydown', { key: 'Escape', isComposing: false, stopPropagation: vi.fn() })
    expect(panel.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    toggle.dispatchEvent('click')
    root.dispatchEvent('keydown', { key: 'Escape', isComposing: true, stopPropagation: vi.fn() })
    expect(panel.hidden).toBe(false)
    widget.dispose()
  })

  it('shows the unsupported status and keeps the old server from accepting sends', () => {
    vi.useFakeTimers()
    const { api, body } = loadSocial()
    const send = vi.fn((message: unknown): boolean => { void message; return true })
    const widget = api.mount({ send })
    const root = body.children[0]
    const input = root.querySelector('textarea')!
    const status = root.querySelector('.social-status')!
    const choices = root.querySelector('.social-presets')!

    widget.setConnected(true)
    widget.receive({ type: 'socialReady', supported: false, protocolVersion: 1 })

    expect(status.textContent).toBe('当前服务器暂不支持便笺')
    expect(choices.children).toHaveLength(0)
    input.value = '旧服务器不会发送'
    input.dispatchEvent('keydown', enterEvent())
    expect(send.mock.calls.filter(([message]) => (message as any).type === 'socialSend')).toHaveLength(0)
    widget.dispose()
  })

  it('keeps fifty records while mute hides arrival prompts and preserves the history', () => {
    vi.useFakeTimers()
    const { widget, root } = readyWidget()
    const panel = root.querySelector('section')!
    const notes = root.querySelector('.social-notes')!
    const toast = root.querySelector('.social-arrival-note')!
    const toggle = root.querySelector('.social-toggle')!
    const mute = panel.querySelector('.social-mute')!

    widget.receive({ type: 'socialEvent', messageId: 'before-mute', kind: 'text', displayName: 'Alice', payload: '可见记录' })
    expect(toast.hidden).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(toggle.classList.contains('has-note')).toBe(false)

    mute.dispatchEvent('click')
    expect(mute.textContent).toBe('恢复提示')
    expect(mute.getAttribute('aria-pressed')).toBe('true')
    expect(toast.hidden).toBe(true)

    for (let index = 0; index < 55; index += 1) {
      widget.receive({
        type: 'socialEvent',
        messageId: `muted-${index}`,
        kind: 'text',
        displayName: 'Bob',
        payload: `记录-${index}`,
      })
    }

    expect(notes.children).toHaveLength(50)
    expect(notes.children[49].children[1].textContent).toBe('记录-54')
    expect(toast.hidden).toBe(true)
    expect(toggle.classList.contains('has-note')).toBe(false)
    widget.dispose()
  })

  it('ignores a stale socialReady received after disconnect', () => {
    vi.useFakeTimers()
    const { api, body } = loadSocial()
    const send = vi.fn((message: unknown): boolean => { void message; return true })
    const widget = api.mount({ send })
    const root = body.children[0]
    const status = root.querySelector('.social-status')!
    const choices = root.querySelector('.social-presets')!

    widget.setConnected(true)
    widget.receive({ type: 'socialReady', supported: true, protocolVersion: 1, presetIds: ['hello'] })
    expect(choices.children).toHaveLength(1)

    widget.setConnected(false)
    send.mockClear()
    widget.receive({ type: 'socialReady', supported: true, protocolVersion: 1, presetIds: ['hello', 'gg'] })

    expect(status.textContent).toBe('连接断开，草稿已保留')
    expect(choices.children).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
    widget.dispose()
  })

  it('mounts offline chat for practice and training while leaving PvP on Colyseus', () => {
    const page = readFileSync('data/pages/battle.html', 'utf8').replace(/\r\n/g, '\n')
    expect(page).toContain('function mountOfflineBattleSocial()')
    expect(page).toContain('if (PRACTICE_MODE) { mountOfflineBattleSocial(); await initPracticeBattle(); return }')
    expect(page).toContain('if (TRAINING_MODE) {\n        mountOfflineBattleSocial()')
    expect(page).toContain('battleSocial = window.BattleSocial.mount({ spectating: SPECTATE_MODE, send: message => RvBColyseus.send(message) })')
    expect(page).toContain("offlineNotice: modeLabel + '：当前没有真人对手，聊天不可发送'")
  })
})
