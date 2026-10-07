import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

type Attribute = { name: string; value: string }

class FakeDocument {
  readonly elements = new Map<string, FakeElement>()

  getElementById(id: string) { return this.elements.get(id) || null }

  createElement(tagName: string) {
    return tagName.toLowerCase() === 'template'
      ? new FakeTemplate(this)
      : new FakeElement(this, tagName)
  }
}

class FakeElement {
  readonly ownerDocument: FakeDocument
  readonly tagName: string
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes: Attribute[] = []
  parentNode: FakeElement | null = null
  className = ''
  hidden = false
  textContent = ''
  innerHTML = ''

  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument
    this.tagName = tagName.toUpperCase()
  }

  get parentElement() { return this.parentNode }

  setAttribute(name: string, value: string) {
    const existing = this.attributes.find(attribute => attribute.name === name)
    if (existing) existing.value = String(value)
    else this.attributes.push({ name, value: String(value) })
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
      this.dataset[key] = String(value)
    }
    if (name === 'class') this.className = String(value)
  }

  getAttribute(name: string) { return this.attributes.find(attribute => attribute.name === name)?.value ?? null }

  removeAttribute(name: string) {
    const index = this.attributes.findIndex(attribute => attribute.name === name)
    if (index >= 0) this.attributes.splice(index, 1)
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
      delete this.dataset[key]
    }
    if (name === 'class') this.className = ''
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

  contains(node: FakeElement | null): boolean { return node === this || this.children.some(child => child.contains(node)) }
}

class FakeTemplate {
  readonly ownerDocument: FakeDocument
  content: { firstElementChild: FakeElement | null } = { firstElementChild: null }
  firstElementChild: FakeElement | null = null

  constructor(ownerDocument: FakeDocument) { this.ownerDocument = ownerDocument }

  set innerHTML(value: string) {
    if (!this.content) return
    const source = String(value).trim()
    const match = source.match(/^<([a-z][\w-]*)([^>]*)>([\s\S]*)<\/\1>$/i)
    if (!match) {
      this.content.firstElementChild = null
      this.firstElementChild = null
      return
    }
    const element = new FakeElement(this.ownerDocument, match[1])
    for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2])
    element.innerHTML = match[3]
    this.content.firstElementChild = element
    this.firstElementChild = element
  }

  get innerHTML() { return '' }
}

function loadUi(document: FakeDocument) {
  const windowObject: Record<string, unknown> = { document }
  const context = createContext({ window: windowObject, globalThis: windowObject, console })
  new Script(readFileSync('data/pages/js/battle-ui/battle-dom-patch.js', 'utf8')).runInContext(context)
  new Script(readFileSync('data/pages/js/battle-ui/battle-dom-ui.js', 'utf8')).runInContext(context)
  return (windowObject.BattleDomUI as { create: (options: { document: FakeDocument }) => { update: (model: unknown) => void } }).create({ document })
}

function player(id: string, name: string, faction: string, action: number, charge: number, isCurrent: boolean) {
  return {
    id, name, faction, isCurrent,
    resources: { action, maxAction: 3, charge, maxCharge: 4 },
    statusSummary: [], buffSummary: [], ruleSummary: [],
  }
}

function model(viewer: ReturnType<typeof player>, players: ReturnType<typeof player>[]) {
  return {
    turn: { currentPlayerId: viewer.id, isViewerTurn: true, number: 1, phase: 'action', remainingSeconds: 20 },
    viewer,
    players,
  }
}

describe('battle HUD DOM integration', () => {
  it('updates AP and player resources through stable keyed roots without replacing containers', () => {
    const document = new FakeDocument()
    const track = new FakeElement(document, 'span')
    const players = new FakeElement(document, 'div')
    document.elements.set('resApTrack', track)
    document.elements.set('playerResCards', players)
    const ui = loadUi(document)
    const alice = player('alice', 'Alice', 'red', 2, 1, true)
    const bob = player('bob', 'Bob', 'blue', 1, 0, false)

    ui.update(model(alice, [alice, bob]))
    const firstApSlot = track.children[0]
    const secondApSlot = track.children[1]
    const thirdApSlot = track.children[2]
    const firstAliceCard = players.children[0]
    const firstBobCard = players.children[1]

    const updatedAlice = player('alice', 'Alice Renamed', 'red', 1, 2, true)
    const updatedBob = player('bob', 'Bob', 'blue', 3, 1, false)
    ui.update(model(updatedAlice, [updatedBob, updatedAlice]))

    expect(track).toBe(document.elements.get('resApTrack'))
    expect(players).toBe(document.elements.get('playerResCards'))
    expect(track.children).toEqual([firstApSlot, secondApSlot, thirdApSlot])
    expect(firstApSlot.dataset.slotIndex).toBe('0')
    expect(secondApSlot.dataset.slotIndex).toBe('1')
    expect(firstApSlot.className).toBe('is-filled')
    expect(secondApSlot.className).toBe('')
    expect(players.children).toEqual([firstBobCard, firstAliceCard])
    expect(firstBobCard.dataset.playerId).toBe('bob')
    expect(firstAliceCard.dataset.playerId).toBe('alice')
    expect(firstAliceCard.innerHTML).toContain('Alice Renamed')
  })
})
