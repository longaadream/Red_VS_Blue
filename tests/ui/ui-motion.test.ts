import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

type Listener = (event: Record<string, unknown>) => void

class FakeClassList {
  private readonly values = new Set<string>()

  add(...names: string[]) { names.forEach(name => this.values.add(name)) }
  remove(...names: string[]) { names.forEach(name => this.values.delete(name)) }
  contains(name: string) { return this.values.has(name) }
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Array<{ handler: Listener; capture: boolean }>>()

  addEventListener(type: string, handler: Listener, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture
    const entries = this.listeners.get(type) || []
    entries.push({ handler, capture })
    this.listeners.set(type, entries)
  }

  removeEventListener(type: string, handler: Listener, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture
    const entries = this.listeners.get(type) || []
    this.listeners.set(type, entries.filter(entry => entry.handler !== handler || entry.capture !== capture))
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    const entries = [...(this.listeners.get(type) || [])]
    const payload = { ...event, type, target: event.target || this }
    for (const entry of entries) entry.handler(payload)
    return payload
  }

  listenerCount(type: string) { return (this.listeners.get(type) || []).length }
}

class FakeElement extends FakeEventTarget {
  readonly nodeType = 1
  readonly classList = new FakeClassList()
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  parentElement: FakeElement | null = null
  hidden = false
  disabled = false
  onclick: (() => void) | null = null
  style = { transform: '' }
  tagName: string
  id = ''
  animations: FakeAnimation[] = []
  rect = { left: 10, top: 20, width: 100, height: 80 }

  constructor(tagName = 'div', className = '') {
    super()
    this.tagName = tagName.toUpperCase()
    className.split(/\s+/).filter(Boolean).forEach(name => this.classList.add(name))
  }

  append(...children: FakeElement[]) {
    for (const child of children) {
      child.parentElement = this
      this.children.push(child)
    }
  }

  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child)
    if (index >= 0) {
      this.children.splice(index, 1)
      child.parentElement = null
    }
    return child
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
    if (name === 'id') this.id = value
    if (name === 'class') value.split(/\s+/).filter(Boolean).forEach(className => this.classList.add(className))
  }

  getAttribute(name: string) { return this.attributes.has(name) ? this.attributes.get(name)! : null }

  contains(target: FakeElement): boolean {
    if (target === this) return true
    return this.children.some(child => child.contains(target))
  }

  private matchesSimple(selector: string): boolean {
    const base = selector.trim()
    if (base === '*') return true
    if (base === 'button') return this.tagName === 'BUTTON'
    if (base === 'a[href]') return this.tagName === 'A' && this.attributes.has('href')
    if (base === 'button, a[href]') return this.tagName === 'BUTTON' || (this.tagName === 'A' && this.attributes.has('href'))
    if (base === '[role="button"]') return this.getAttribute('role') === 'button'
    if (base === '[role="link"]') return this.getAttribute('role') === 'link'
    if (base === '[data-ui-motion]') return this.attributes.has('data-ui-motion')
    if (base === '[data-motion-profile]') return this.attributes.has('data-motion-profile')
    const idMatch = base.match(/^#([\w-]+)/)
    if (idMatch && this.id !== idMatch[1]) return false
    const classes = [...base.matchAll(/\.([\w-]+)/g)].map(match => match[1])
    if (classes.some(className => !this.classList.contains(className))) return false
    const tagMatch = base.match(/^(?:#?[\w-]+)?(?=\.|\[|$)/)
    if (tagMatch?.[0] && !tagMatch[0].startsWith('#') && !tagMatch[0].startsWith('.') && tagMatch[0] !== this.tagName.toLowerCase()) return false
    const roleMatch = base.match(/\[role=["']([^"']+)["']\]/)
    if (roleMatch && this.getAttribute('role') !== roleMatch[1]) return false
    const attrMatch = base.match(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/)
    if (attrMatch) {
      const value = this.getAttribute(attrMatch[1])
      if (value === null || (attrMatch[2] && value !== attrMatch[2])) return false
    }
    if (base.includes(':not(.expanded)') && this.classList.contains('expanded')) return false
    if (base.includes(':not(.is-unavailable)') && this.classList.contains('is-unavailable')) return false
    return true
  }

  matches(selector: string): boolean {
    const direct = selector.split(',').map(part => part.trim())
    for (const part of direct) {
      const child = part.match(/^(.+?)\s*>\s*(.+)$/)
      if (child) {
        if (!this.matchesSimple(child[2])) continue
        if (this.parentElement && this.parentElement.matches(child[1])) return true
        continue
      }
      const descendant = part.match(/^(.+?)\s+(.+)$/)
      if (descendant) {
        if (!this.matchesSimple(descendant[2])) continue
        let parent = this.parentElement
        while (parent) {
          if (parent.matches(descendant[1])) return true
          parent = parent.parentElement
        }
        continue
      }
      if (this.matchesSimple(part)) return true
    }
    return false
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this
    return this.parentElement ? this.parentElement.closest(selector) : null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = []
    const visit = (element: FakeElement) => {
      for (const child of element.children) {
        if (child.matches(selector)) result.push(child)
        visit(child)
      }
    }
    visit(this)
    return result
  }

  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] || null }

  getBoundingClientRect() { return this.rect }

  animate(keyframes: Array<Record<string, unknown>>, options: Record<string, unknown>) {
    const animation = new FakeAnimation(keyframes, options)
    this.animations.push(animation)
    return animation
  }
}

class FakeAnimation {
  currentTime: number | null = null
  canceled = false
  paused = false
  readonly effect = {
    setKeyframes: (keyframes: Array<Record<string, unknown>>) => { this.keyframes = keyframes },
  }

  constructor(public keyframes: Array<Record<string, unknown>>, public readonly options: Record<string, unknown>) {}
  pause() { this.paused = true }
  cancel() { this.canceled = true }
}

class FakeMutationObserver {
  disconnected = false

  constructor(private readonly callback: () => void) {}

  observe() {}
  disconnect() { this.disconnected = true }
  trigger() { if (!this.disconnected) this.callback() }
}

class FakeDocument extends FakeEventTarget {
  readonly documentElement = new FakeElement('html')
  readonly body = new FakeElement('body')
  readyState = 'complete'
  hidden = false

  constructor() {
    super()
    this.documentElement.append(this.body)
  }
}

function loadApi(windowRef: FakeWindow) {
  const context = createContext({ window: windowRef, globalThis: windowRef, self: windowRef })
  new Script(readFileSync(resolve('data/pages/js/ui-motion.js'), 'utf8')).runInContext(context)
  return (windowRef as FakeWindow & { UiMotion: { create: (options: unknown) => ReturnType<typeof Object> } }).UiMotion
}

class FakeWindow extends FakeEventTarget {
  readonly document: FakeDocument
  readonly frames: Array<(time: number) => void> = []
  readonly fineMedia = new FakeEventTarget() as FakeEventTarget & { matches: boolean }
  readonly reducedMedia = new FakeEventTarget() as FakeEventTarget & { matches: boolean }
  readonly mutationObservers: FakeMutationObserver[] = []
  readonly MutationObserver: new (callback: () => void) => FakeMutationObserver
  nextFrameId = 1

  constructor(documentRef: FakeDocument, options: { fine?: boolean; reduced?: boolean } = {}) {
    super()
    this.document = documentRef
    this.fineMedia.matches = options.fine !== false
    this.reducedMedia.matches = options.reduced === true
    const observers = this.mutationObservers
    this.MutationObserver = class extends FakeMutationObserver {
      constructor(callback: () => void) {
        super(callback)
        observers.push(this)
      }
    }
  }

  matchMedia(query: string) { return query.includes('pointer') ? this.fineMedia : this.reducedMedia }
  requestAnimationFrame(callback: (time: number) => void) { this.frames.push(callback); return this.nextFrameId++ }
  cancelAnimationFrame() { this.frames.shift() }
  flushFrames(count = 1) {
    for (let index = 0; index < count && this.frames.length; index += 1) this.frames.shift()!(index * 16 + 16)
  }
}

function setup(options: { fine?: boolean; reduced?: boolean } = {}) {
  const documentRef = new FakeDocument()
  const windowRef = new FakeWindow(documentRef, options)
  const api = loadApi(windowRef)
  const instance = api.create({ document: documentRef, window: windowRef }) as { destroy: () => void; dispose: () => void }
  return { documentRef, windowRef, api, instance }
}

function handCard(documentRef: FakeDocument) {
  const hand = new FakeElement('div')
  hand.id = 'handCards'
  hand.setAttribute('id', 'handCards')
  const card = new FakeElement('button', 'card-item')
  hand.append(card)
  documentRef.body.append(hand)
  return card
}

function activeSkill(documentRef: FakeDocument) {
  const row = new FakeElement('div', 'pi-skill')
  const icon = new FakeElement('span', 'pi-skill-icon')
  const cast = new FakeElement('button', 'character-cast')
  row.append(icon, cast)
  documentRef.body.append(row)
  return { row, icon, cast }
}

function battleToolbarButton(documentRef: FakeDocument) {
  const toolbar = new FakeElement('div', 'topbar')
  toolbar.setAttribute('data-battle-ui-region', 'player-hud')
  const settings = new FakeElement('button', 'back-btn')
  settings.id = 'battleSettingsButton'
  settings.setAttribute('id', 'battleSettingsButton')
  toolbar.append(settings)
  documentRef.body.append(toolbar)
  return settings
}

function button(documentRef: FakeDocument, className = 'button') {
  const control = new FakeElement('button', className)
  documentRef.body.append(control)
  return control
}

function pointer(type: string, target: FakeElement, values: Record<string, unknown> = {}) {
  return { pointerType: type, pointerId: 1, clientX: 60, clientY: 60, target, ...values }
}

function rotateY(animation: FakeAnimation) {
  const transform = String(animation.keyframes[0].transform || '')
  return Number(transform.match(/rotateY\((-?[0-9.]+)deg\)/)?.[1] || 0)
}

describe('RED-226 shared physical UI motion', () => {
  it('exposes visible hover and press state on real battle hand, skill, and toolbar controls', () => {
    const { documentRef, windowRef } = setup()
    const card = handCard(documentRef)
    const skill = activeSkill(documentRef)
    const settings = battleToolbarButton(documentRef)

    windowRef.dispatch('pointerover', pointer('mouse', card, { clientX: 90 }))
    expect(card.classList.contains('ui-motion-hover')).toBe(true)
    expect(card.classList.contains('ui-motion-pressed')).toBe(false)

    windowRef.dispatch('pointerover', pointer('mouse', skill.icon, { clientX: 90 }))
    expect(skill.row.classList.contains('ui-motion-hover')).toBe(true)
    expect(skill.row.classList.contains('ui-motion-pressed')).toBe(false)

    windowRef.dispatch('pointerover', pointer('mouse', settings, { clientX: 90 }))
    windowRef.dispatch('pointerdown', pointer('mouse', settings))
    expect(settings.classList.contains('ui-motion-hover')).toBe(true)
    expect(settings.classList.contains('ui-motion-pressed')).toBe(true)

    windowRef.dispatch('pointerup', pointer('mouse', settings))
    expect(settings.classList.contains('ui-motion-pressed')).toBe(false)
    expect(settings.classList.contains('ui-motion-hover')).toBe(true)

    windowRef.dispatch('pointerout', pointer('mouse', settings, { relatedTarget: documentRef.body }))
    expect(settings.classList.contains('ui-motion-hover')).toBe(false)
  })

  it('keeps the stronger tilt confined to battle surfaces', () => {
    const { documentRef, windowRef } = setup()
    const generic = button(documentRef)
    windowRef.dispatch('pointerover', pointer('mouse', generic, { clientX: 110 }))
    windowRef.flushFrames(20)
    const genericTilt = Math.abs(rotateY(generic.animations[generic.animations.length - 1]))

    const card = handCard(documentRef)
    windowRef.dispatch('pointerover', pointer('mouse', card, { clientX: 110 }))
    windowRef.flushFrames(20)
    const battleTilt = Math.abs(rotateY(card.animations[card.animations.length - 1]))

    expect(genericTilt).toBeGreaterThan(1)
    expect(genericTilt).toBeLessThan(2.1)
    expect(battleTilt).toBeGreaterThan(genericTilt)
    expect(battleTilt).toBeLessThan(6.1)
  })

  it('adds the fine-pointer root capability without touching the source transform', () => {
    const { documentRef, windowRef, instance } = setup()
    const card = handCard(documentRef)
    card.style.transform = 'translateY(-10px) scale(1.06)'

    windowRef.dispatch('pointerover', pointer('mouse', card, { clientX: 110 }))
    windowRef.flushFrames(20)

    expect(documentRef.documentElement.classList.contains('ui-motion-ready')).toBe(true)
    expect(card.style.transform).toBe('translateY(-10px) scale(1.06)')
    expect(card.animations[0].options.composite).toBe('add')
    expect(card.animations[0].paused).toBe(true)
    expect(String(card.animations[0].keyframes[0].transform)).toMatch(/rotateY\([45]\./)

    instance.destroy()
    expect(documentRef.documentElement.classList.contains('ui-motion-ready')).toBe(false)
    expect(card.animations.some(animation => animation.canceled)).toBe(true)
  })

  it('keeps one hovered target, settles after a finite spring, and cancels on leave', () => {
    const { documentRef, windowRef } = setup()
    const first = handCard(documentRef)
    const second = button(documentRef)
    windowRef.dispatch('pointerover', pointer('mouse', first, { clientX: 90 }))
    windowRef.flushFrames(80)
    const firstAnimation = first.animations[first.animations.length - 1]
    windowRef.dispatch('pointerover', pointer('mouse', second, { clientX: 60 }))
    windowRef.flushFrames(100)
    expect(firstAnimation.canceled).toBe(true)
    expect(second.animations.length).toBeGreaterThan(0)

    windowRef.dispatch('pointerout', pointer('mouse', second, { relatedTarget: documentRef.body }))
    windowRef.flushFrames(100)
    expect(second.animations.some(animation => animation.canceled)).toBe(true)
    expect(windowRef.frames).toHaveLength(0)
  })

  it('ignores touch, disabled controls, passive cards, and reduced-motion mode', () => {
    const normal = setup()
    const touchCard = handCard(normal.documentRef)
    normal.windowRef.dispatch('pointerover', pointer('touch', touchCard))
    normal.windowRef.flushFrames(2)
    expect(touchCard.animations).toHaveLength(0)

    const disabled = button(normal.documentRef)
    disabled.disabled = true
    normal.windowRef.dispatch('pointerover', pointer('mouse', disabled))
    normal.windowRef.flushFrames(2)
    expect(disabled.animations).toHaveLength(0)

    const passive = button(normal.documentRef)
    passive.setAttribute('data-ui-motion', 'static')
    normal.windowRef.dispatch('pointerover', pointer('mouse', passive))
    normal.windowRef.flushFrames(2)
    expect(passive.animations).toHaveLength(0)

    const reduced = setup({ reduced: true })
    const reducedCard = handCard(reduced.documentRef)
    reduced.windowRef.dispatch('pointerover', pointer('mouse', reducedCard))
    reduced.windowRef.flushFrames(2)
    expect(reducedCard.animations).toHaveLength(0)
    expect(reduced.documentRef.documentElement.classList.contains('ui-motion-ready')).toBe(true)
  })

  it('clears decorative tilt in window capture before document drag geometry and gives press feedback', () => {
    const { documentRef, windowRef } = setup()
    const card = handCard(documentRef)
    const order: string[] = []
    documentRef.addEventListener('pointerdown', () => {
      order.push('drag-geometry')
      expect(card.animations[card.animations.length - 1].keyframes[0].transform).toContain('rotateX(0.')
    }, true)

    windowRef.dispatch('pointerover', pointer('mouse', card, { clientX: 90 }))
    windowRef.flushFrames(16)
    windowRef.dispatch('pointerdown', pointer('mouse', card))
    expect(card.classList.contains('ui-motion-pressed')).toBe(true)
    windowRef.dispatch('pointermove', pointer('mouse', card, { clientX: 80 }))
    expect(card.classList.contains('ui-motion-hover')).toBe(false)
    expect(card.classList.contains('ui-motion-pressed')).toBe(false)
    documentRef.dispatch('pointerdown', pointer('mouse', card))
    order.push('after-window-capture')
    windowRef.flushFrames(2)

    expect(order).toEqual(['drag-geometry', 'after-window-capture'])
    expect(card.animations[card.animations.length - 1].keyframes[0].transform).toContain('scale(1.00000)')
  })

  it('does not revive hover when a click leaves the card before pointerup', () => {
    const { documentRef, windowRef } = setup()
    const card = handCard(documentRef)

    windowRef.dispatch('pointerover', pointer('mouse', card, { clientX: 110 }))
    windowRef.flushFrames(16)
    windowRef.dispatch('pointerdown', pointer('mouse', card, { clientX: 110 }))
    windowRef.dispatch('pointerout', pointer('mouse', card, { relatedTarget: documentRef.body, clientX: 111 }))
    windowRef.dispatch('pointerup', pointer('mouse', documentRef.body, { clientX: 220, clientY: 120 }))
    windowRef.flushFrames(120)

    const lastAnimation = card.animations[card.animations.length - 1]
    expect(lastAnimation.keyframes[0].transform).toContain('rotateX(0.0000deg) rotateY(0.0000deg)')
    expect(lastAnimation.canceled).toBe(true)
    expect(windowRef.frames).toHaveLength(0)
  })

  it('reprofiles disabled and targeting mutations, removes detached states, and handles late controls', () => {
    const { documentRef, windowRef } = setup()
    const card = handCard(documentRef)

    windowRef.dispatch('pointerover', pointer('mouse', card, { clientX: 110 }))
    windowRef.flushFrames(12)
    const cardAnimation = card.animations[card.animations.length - 1]
    expect(cardAnimation.canceled).toBe(false)

    card.disabled = true
    windowRef.mutationObservers[0].trigger()
    expect(cardAnimation.canceled).toBe(true)

    const late = button(documentRef)
    windowRef.dispatch('pointerover', pointer('mouse', late, { clientX: 12 }))
    windowRef.flushFrames(12)
    const lateAnimation = late.animations[late.animations.length - 1]
    expect(lateAnimation.canceled).toBe(false)

    documentRef.body.classList.add('target-mode-active')
    windowRef.mutationObservers[0].trigger()
    expect(lateAnimation.canceled).toBe(true)

    documentRef.body.classList.remove('target-mode-active')
    documentRef.body.removeChild(late)
    windowRef.mutationObservers[0].trigger()
    expect(lateAnimation.canceled).toBe(true)

    const inserted = button(documentRef)
    windowRef.dispatch('pointerover', pointer('mouse', inserted, { clientX: 12 }))
    windowRef.flushFrames(12)
    expect(inserted.animations.length).toBeGreaterThan(0)
  })

  it('keeps create and duplicate UMD loads idempotent after auto-init', () => {
    const { documentRef, windowRef, api, instance } = setup()
    const listenerCounts = ['pointerdown', 'pointerover', 'pointermove', 'pointerout', 'pointerup', 'pointercancel']
      .map(type => windowRef.listenerCount(type))

    expect(api.create({ document: documentRef, window: windowRef })).toBe(instance)
    expect(listenerCounts.map((_, index) => windowRef.listenerCount(['pointerdown', 'pointerover', 'pointermove', 'pointerout', 'pointerup', 'pointercancel'][index])))
      .toEqual(listenerCounts)

    const duplicateApi = loadApi(windowRef)
    expect(duplicateApi.create({ document: documentRef, window: windowRef })).toBe(instance)
    expect(['pointerdown', 'pointerover', 'pointermove', 'pointerout', 'pointerup', 'pointercancel']
      .map(type => windowRef.listenerCount(type))).toEqual(listenerCounts)
  })

  it('resets motion when fine-pointer or reduced-motion media changes', () => {
    const fine = setup()
    const fineCard = handCard(fine.documentRef)
    fine.windowRef.dispatch('pointerover', pointer('mouse', fineCard, { clientX: 110 }))
    fine.windowRef.flushFrames(12)
    const fineAnimation = fineCard.animations[fineCard.animations.length - 1]

    fine.windowRef.fineMedia.matches = false
    fine.windowRef.fineMedia.dispatch('change', { matches: false })
    expect(fineAnimation.canceled).toBe(true)
    expect(fine.documentRef.documentElement.classList.contains('ui-motion-fine-pointer')).toBe(false)

    fine.windowRef.fineMedia.matches = true
    fine.windowRef.fineMedia.dispatch('change', { matches: true })
    expect(fine.documentRef.documentElement.classList.contains('ui-motion-fine-pointer')).toBe(true)

    const reduced = setup()
    const reducedCard = handCard(reduced.documentRef)
    reduced.windowRef.dispatch('pointerover', pointer('mouse', reducedCard, { clientX: 110 }))
    reduced.windowRef.flushFrames(12)
    const reducedAnimation = reducedCard.animations[reducedCard.animations.length - 1]

    reduced.windowRef.reducedMedia.matches = true
    reduced.windowRef.reducedMedia.dispatch('change', { matches: true })
    expect(reducedAnimation.canceled).toBe(true)
    expect(reduced.documentRef.documentElement.classList.contains('ui-motion-ready')).toBe(true)

    reduced.windowRef.reducedMedia.matches = false
    reduced.windowRef.reducedMedia.dispatch('change', { matches: false })
    reduced.windowRef.dispatch('pointerover', pointer('mouse', reducedCard, { clientX: 110 }))
    reduced.windowRef.flushFrames(12)
    expect(reducedCard.animations.some(animation => !animation.canceled)).toBe(true)
  })

  it.each(['blur', 'pagehide', 'visibilitychange'] as const)('clears state on %s', eventName => {
    const { documentRef, windowRef } = setup()
    const card = handCard(documentRef)
    windowRef.dispatch('pointerover', pointer('mouse', card, { clientX: 110 }))
    windowRef.flushFrames(12)
    const animation = card.animations[card.animations.length - 1]

    if (eventName === 'visibilitychange') documentRef.hidden = true
    if (eventName === 'visibilitychange') documentRef.dispatch(eventName)
    else windowRef.dispatch(eventName)
    windowRef.flushFrames(120)

    expect(animation.canceled).toBe(true)
    expect(windowRef.frames).toHaveLength(0)
  })

  it('destroy disconnects lifecycle resources and remains safe when repeated', () => {
    const { documentRef, windowRef, instance } = setup()
    const card = handCard(documentRef)
    windowRef.dispatch('pointerover', pointer('mouse', card, { clientX: 110 }))
    expect(windowRef.frames.length).toBeGreaterThan(0)
    windowRef.flushFrames(1)
    const animation = card.animations[card.animations.length - 1]
    const observer = windowRef.mutationObservers[0]

    instance.destroy()
    instance.destroy()

    expect(animation.canceled).toBe(true)
    expect(observer.disconnected).toBe(true)
    expect(windowRef.frames).toHaveLength(0)
    expect(documentRef.documentElement.classList.contains('ui-motion-enabled')).toBe(false)
    expect(windowRef.listenerCount('pointerover')).toBe(0)
    expect(windowRef.listenerCount('pointerdown')).toBe(0)
    expect(documentRef.listenerCount('visibilitychange')).toBe(0)

    const late = button(documentRef)
    windowRef.dispatch('pointerover', pointer('mouse', late, { clientX: 110 }))
    windowRef.flushFrames(12)
    expect(late.animations).toHaveLength(0)
  })
})
