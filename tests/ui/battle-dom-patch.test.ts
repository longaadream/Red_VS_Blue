import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'

import { describe, expect, it } from 'vitest'

type Attributes = Array<{ name: string; value: string }>

class FakeDocument {
  activeElement: FakeElement | null = null
}

class FakeElement {
  readonly ownerDocument: FakeDocument
  readonly tagName: string
  readonly dataset: Record<string, string> = {}
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Array<() => void>>()
  parentNode: FakeElement | null = null
  innerHTML = ''
  private readonly attrs: Attributes = []

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument
    this.tagName = tagName.toUpperCase()
  }

  get attributes() { return this.attrs }
  get parentElement() { return this.parentNode }

  setAttribute(name: string, value: string) {
    const existing = this.attrs.find(attribute => attribute.name === name)
    if (existing) existing.value = String(value)
    else this.attrs.push({ name, value: String(value) })
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
      this.dataset[key] = String(value)
    }
  }

  getAttribute(name: string) { return this.attrs.find(attribute => attribute.name === name)?.value ?? null }

  removeAttribute(name: string) {
    const index = this.attrs.findIndex(attribute => attribute.name === name)
    if (index >= 0) this.attrs.splice(index, 1)
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
      delete this.dataset[key]
    }
  }

  appendChild(child: FakeElement) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(child: FakeElement, before: FakeElement | null) {
    if (child.parentNode) child.parentNode.removeChild(child)
    const index = before ? this.children.indexOf(before) : -1
    child.parentNode = this
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  contains(node: FakeElement | null): boolean {
    if (!node) return false
    if (node === this) return true
    return this.children.some(child => child.contains(node))
  }

  focus() { this.ownerDocument.activeElement = this }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatchEvent(type: string) { (this.listeners.get(type) || []).forEach(listener => listener()) }
}

function loadPatch() {
  const windowObject: Record<string, unknown> = {}
  const context = createContext({ window: windowObject, globalThis: windowObject })
  new Script(readFileSync(resolve('data/pages/js/battle-ui/battle-dom-patch.js'), 'utf8')).runInContext(context)
  return windowObject.BattleDomPatch as { patchKeyed: (container: FakeElement, entries: Array<{ key: string; html: string }>, options: { datasetKey: string; parse: (html: string) => FakeElement }) => void }
}

function parser(document: FakeDocument) {
  return (html: string) => {
    const tag = html.match(/^<([a-z]+)/i)?.[1] || 'div'
    const node = new FakeElement(document, tag)
    const attrs = html.match(/^<[a-z]+([^>]*)>/i)?.[1] || ''
    for (const match of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(match[1], match[2])
    node.innerHTML = html.replace(/^<[\s\S]*?>|<\/[\s\S]*?>$/g, '')
    return node
  }
}

describe('battle keyed DOM patching', () => {
  it('keeps skill and hand roots when AP or cooldown state changes', () => {
    const document = new FakeDocument()
    const host = new FakeElement(document, 'div')
    const patch = loadPatch()
    const parse = parser(document)
    const options = { datasetKey: 'skillId', parse }

    patch.patchKeyed(host, [
      { key: 'skill-a', html: '<button data-skill-id="skill-a" aria-disabled="false">AP 1 · CD 1</button>' },
      { key: 'skill-b', html: '<button data-skill-id="skill-b" aria-disabled="false">AP 2 · CD 2</button>' },
    ], options)
    const firstSkill = host.children[0]
    firstSkill.focus()

    patch.patchKeyed(host, [
      { key: 'skill-b', html: '<button data-skill-id="skill-b" aria-disabled="true">AP不足</button>' },
      { key: 'skill-a', html: '<button data-skill-id="skill-a" aria-disabled="false">AP 1 · CD 0</button>' },
      { key: 'skill-c', html: '<button data-skill-id="skill-c" aria-disabled="false">AP 0</button>' },
    ], options)

    expect(host.children[1]).toBe(firstSkill)
    expect(firstSkill.innerHTML).toBe('AP 1 · CD 0')
    expect(host.children[0].getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(firstSkill)
  })

  it('preserves unchanged roots, focus, order, and one existing listener while updating attributes', () => {
    const document = new FakeDocument()
    const host = new FakeElement(document, 'div')
    const patch = loadPatch()
    const parse = parser(document)
    const options = { datasetKey: 'instanceId', parse }

    patch.patchKeyed(host, [
      { key: 'a', html: '<button data-instance-id="a" class="ready">first</button>' },
      { key: 'b', html: '<button data-instance-id="b" class="ready">second</button>' },
    ], options)
    const first = host.children[0]
    const second = host.children[1]
    const unchangedChild = new FakeElement(document, 'span')
    first.appendChild(unchangedChild)
    let clicks = 0
    first.addEventListener('click', () => { clicks += 1 })
    first.focus()

    patch.patchKeyed(host, [
      { key: 'b', html: '<button data-instance-id="b" class="ready">second updated</button>' },
      { key: 'a', html: '<button data-instance-id="a" class="disabled" aria-disabled="true">first updated</button>' },
      { key: 'c', html: '<button data-instance-id="c" class="ready">new</button>' },
    ], options)

    expect(host.children).toEqual([second, first, host.children[2]])
    expect(host.children[0]).toBe(second)
    expect(host.children[1]).toBe(first)
    expect(host.children[1].getAttribute('class')).toBe('disabled')
    expect(host.children[1].getAttribute('aria-disabled')).toBe('true')
    expect(host.children[1].innerHTML).toBe('first updated')
    expect(document.activeElement).toBe(first)
    first.dispatchEvent('click')
    expect(clicks).toBe(1)

    patch.patchKeyed(host, [
      { key: 'b', html: '<button data-instance-id="b" class="ready">second updated</button>' },
      { key: 'a', html: '<button data-instance-id="a" class="disabled" aria-disabled="true">first updated</button>' },
      { key: 'c', html: '<button data-instance-id="c" class="ready">new</button>' },
    ], options)
    expect(first.children[0]).toBe(unchangedChild)
  })

  it('removes stale keyed nodes without replacing the host', () => {
    const document = new FakeDocument()
    const host = new FakeElement(document, 'div')
    const patch = loadPatch()
    const parse = parser(document)
    const options = { datasetKey: 'pieceId', parse }
    patch.patchKeyed(host, [
      { key: 'piece-1', html: '<div data-piece-id="piece-1">one</div>' },
      { key: 'piece-2', html: '<div data-piece-id="piece-2">two</div>' },
    ], options)
    const kept = host.children[1]

    patch.patchKeyed(host, [{ key: 'piece-2', html: '<div data-piece-id="piece-2">updated</div>' }], options)

    expect(host.children).toEqual([kept])
    expect(kept.innerHTML).toBe('updated')
  })
})
